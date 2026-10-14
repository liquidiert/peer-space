import { ref, watch, onUnmounted } from 'vue';
import type { Socket } from 'socket.io-client';
import type { User } from '../types';
import { AudioEngine, AudioSender, RemoteAudio } from '../lib/media/audio';
import { createIrohTransport, type LinkEvent, type MediaTransport, type PeerLink, type TrackOut } from '../lib/media/transport';
import {
  CAMERA_PROFILE,
  SCREEN_PROFILE,
  VideoReceiver,
  VideoSender,
  type VideoProfile,
} from '../lib/media/video';
import {
  announceMessage,
  decodePacket,
  encodeAudio,
  encodeControl,
  fromHex,
  toHex,
  validAnnounce,
  type AudioCodec,
  type AudioPacket,
  type VideoPacket,
  type VideoTrackKind,
} from '../lib/media/wire';

/**
 * Proximity audio/video over iroh.
 *
 * Every browser runs an iroh endpoint (wasm, see crates/peer-media) and announces its
 * endpoint id over the socket. Peers then dial each other directly by id: there is no
 * offer/answer or ICE exchange to get wrong, a reconnect is just another dial, and the
 * connection is authenticated by the peer's key. Browsers can't do UDP hole punching, so
 * the traffic flows through an iroh relay (n0's public ones unless VITE_IROH_RELAYS is set).
 *
 * Compared with the mesh of RTCPeerConnections this replaces:
 * - audio and video are encoded once and fanned out, not once per peer;
 * - audio is only sent to peers in earshot, and video only to peers in range;
 * - audio rides QUIC datagrams (never waits behind a lost packet), video rides one ordered
 *   stream per track that drops frames instead of queueing when a link can't keep up.
 */

/** Link states, named like RTCPeerConnectionState so the UI's health reporting reads the same. */
export type LinkState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

interface AudioEngineLike {
  readonly suspended: boolean;
  readonly ctx?: AudioContext;
  resume(): Promise<void>;
  close(): void;
}
interface AudioSenderLike {
  enabled: boolean;
  start(stream: MediaStream): Promise<void>;
  replaceStream(stream: MediaStream): void;
  stop(): void;
}
interface RemoteAudioLike {
  volume: number;
  readonly input?: AudioNode;
  push(packet: AudioPacket): void;
  close(): void;
}
interface VideoSenderLike {
  readonly subscriberIds: string[];
  start(): void;
  has(peerId: string): boolean;
  subscribe(peerId: string, out: TrackOut): void;
  unsubscribe(peerId: string): void;
  requestKeyframe(peerId?: string): void;
  replaceTrack(track: MediaStreamTrack): void;
  stop(): void;
}
interface VideoReceiverLike {
  readonly stream: MediaStream;
  push(packet: VideoPacket): void;
  close(): void;
}

/** Everything that touches the network or the media stack, swappable for tests. */
export interface MediaDeps {
  createTransport: () => Promise<MediaTransport>;
  createAudioEngine: () => AudioEngineLike;
  createAudioSender: (
    engine: AudioEngineLike,
    onPacket: (codec: AudioCodec, seq: number, payload: Uint8Array) => void
  ) => AudioSenderLike;
  createRemoteAudio: (engine: AudioEngineLike) => RemoteAudioLike;
  createVideoSender: (kind: VideoTrackKind, track: MediaStreamTrack, profile: VideoProfile) => VideoSenderLike;
  createVideoReceiver: (onKeyframeNeeded: () => void, onFirstFrame: () => void) => VideoReceiverLike;
}

export const defaultMediaDeps: MediaDeps = {
  createTransport: createIrohTransport,
  createAudioEngine: () => new AudioEngine(),
  createAudioSender: (engine, onPacket) => new AudioSender(engine as AudioEngine, onPacket),
  createRemoteAudio: (engine) => new RemoteAudio(engine as AudioEngine),
  createVideoSender: (kind, track, profile) => new VideoSender(kind, track, profile),
  createVideoReceiver: (onKey, onFirst) => new VideoReceiver(onKey, onFirst),
};

/** Stream priorities: control first, then screen (text must stay readable), then camera. */
const PRIORITY = { control: 100, screen: 20, camera: 10 } as const;
/** Frames that may wait per video stream before new ones are dropped: bounds added delay. */
const VIDEO_QUEUE = 3;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;

interface Peer {
  socketId: string;
  endpointId: string;
  relay?: string;
  link: PeerLink | null;
  control: TrackOut | null;
  dialing: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
  receivers: Map<VideoTrackKind, VideoReceiverLike>;
}

export function useProximityMedia(
  socketRef: { value: Socket | null },
  currentUserRef: { value: User },
  usersRef: { value: User[] },
  isMutedRef: { value: boolean },
  isDeafenedRef: { value: boolean },
  deps: MediaDeps = defaultMediaDeps
) {
  const localAudioStream = ref<MediaStream | null>(null);
  const localVideoStream = ref<MediaStream | null>(null);
  const localScreenStream = ref<MediaStream | null>(null);
  const isMicAvailable = ref(false);
  const isVideoOn = ref(false);
  const remoteVideoStreams = ref<Map<string, MediaStream>>(new Map());

  // Camera device switching (front/back on mobile, multiple webcams on desktop)
  const availableVideoDevices = ref<MediaDeviceInfo[]>([]);
  const currentVideoDeviceId = ref<string | null>(null);

  async function refreshVideoDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableVideoDevices.value = devices.filter((d) => d.kind === 'videoinput');
    } catch (err) {
      console.warn('Could not enumerate video devices:', err);
    }
  }

  if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.('devicechange', refreshVideoDevices);
  }

  // ==========================================
  // TRANSPORT
  // ==========================================
  let transport: MediaTransport | null = null;
  let transportPromise: Promise<void> | null = null;
  let disposed = false;
  /** Socket id our endpoint was last announced for; a socket reconnect needs a new announce. */
  let announcedFor: string | null = null;

  /** Remote peers with a verified media announce, by socket id. */
  const peers = new Map<string, Peer>();
  /** Incoming links whose announce we haven't seen yet, by endpoint id. */
  const pendingLinks = new Map<string, PeerLink>();
  const verifiedAnnounces = new Map<string, boolean>();

  function ensureTransport() {
    if (transportPromise || disposed) return;
    transportPromise = deps
      .createTransport()
      .then((t) => {
        if (disposed) {
          t.close();
          return;
        }
        transport = t;
        void acceptLoop(t);
        syncPeerConnections();
      })
      .catch((err) => {
        console.error('Could not start the media endpoint:', err);
        // Let the next sync try again rather than staying silent for the whole session.
        transportPromise = null;
      });
  }

  function announce() {
    const t = transport;
    const myId = currentUserRef.value.socketId;
    if (!t || !myId || !socketRef.value || announcedFor === myId) return;
    const sig = toHex(t.sign(announceMessage(myId, t.id, t.relay ?? '')));
    socketRef.value.emit('media:announce', { endpointId: t.id, relay: t.relay, sig });
    announcedFor = myId;
  }

  async function acceptLoop(t: MediaTransport) {
    for (;;) {
      let link: PeerLink | undefined;
      try {
        link = await t.accept();
      } catch (err) {
        console.warn('accept failed:', err);
        continue;
      }
      if (!link || disposed) return;
      const peer = [...peers.values()].find((p) => p.endpointId === link!.remoteId);
      link.start((ev) => onLinkEvent(link!, ev));
      if (peer) {
        void attachLink(peer, link);
      } else {
        // They announced and dialed before their announce reached us; hold on to it.
        pendingLinks.get(link.remoteId)?.close();
        pendingLinks.set(link.remoteId, link);
      }
    }
  }

  /** The user's announce, if it is well-formed and signed by the endpoint it names. */
  function verifiedMedia(user: User) {
    const media = user.media;
    if (!transport || !validAnnounce(media)) return null;
    const key = `${user.socketId}|${media.endpointId}|${media.relay ?? ''}|${media.sig}`;
    let ok = verifiedAnnounces.get(key);
    if (ok === undefined) {
      ok = transport.verify(media.endpointId, announceMessage(user.socketId, media.endpointId, media.relay ?? ''), fromHex(media.sig));
      verifiedAnnounces.set(key, ok);
    }
    return ok ? media : null;
  }

  /** The lower endpoint id dials, so a pair never ends up with two connections. */
  const isDialer = (peer: Peer) => !!transport && transport.id < peer.endpointId;

  async function dial(peer: Peer) {
    const t = transport;
    if (!t || peer.dialing || peer.link || !isDialer(peer)) return;
    peer.dialing = true;
    setPeerConnectionState(peer.socketId, 'connecting');
    try {
      t.addPeer(peer.endpointId, peer.relay);
      const link = await t.connect(peer.endpointId);
      peer.dialing = false;
      if (peers.get(peer.socketId) !== peer || disposed) {
        link.close();
        return;
      }
      link.start((ev) => onLinkEvent(link, ev));
      await attachLink(peer, link);
    } catch (err) {
      peer.dialing = false;
      if (peers.get(peer.socketId) !== peer) return;
      console.warn(`Could not reach ${peer.socketId}:`, err);
      setPeerConnectionState(peer.socketId, 'failed');
      scheduleRedial(peer);
    }
  }

  function scheduleRedial(peer: Peer) {
    if (peer.retryTimer || disposed || !isDialer(peer)) return;
    peer.retryTimer = setTimeout(() => {
      peer.retryTimer = null;
      if (peers.get(peer.socketId) === peer) void dial(peer);
    }, peer.retryDelay);
    peer.retryDelay = Math.min(RETRY_MAX_MS, peer.retryDelay * 2);
  }

  async function attachLink(peer: Peer, link: PeerLink) {
    if (peer.link && peer.link !== link) detachLink(peer, true);
    peer.link = link;
    peer.retryDelay = RETRY_MIN_MS;
    try {
      const control = await link.openStream(PRIORITY.control, 64);
      if (peer.link !== link) {
        control.close();
        return;
      }
      peer.control = control;
    } catch (err) {
      console.warn(`Could not open control stream to ${peer.socketId}:`, err);
    }
    setPeerConnectionState(peer.socketId, 'connected');
    updatePeerVideoConnections();
  }

  /** Drop everything that rode on the peer's link (but keep the peer). */
  function detachLink(peer: Peer, closeLink: boolean) {
    const link = peer.link;
    peer.link = null;
    peer.control?.close();
    peer.control = null;
    for (const kind of ['camera', 'screen'] as const) {
      videoSenders[kind]?.unsubscribe(peer.socketId);
      dropReceiver(peer, kind);
    }
    if (closeLink) link?.close();
  }

  function removePeer(socketId: string) {
    const peer = peers.get(socketId);
    if (!peer) return;
    peers.delete(socketId);
    if (peer.retryTimer) clearTimeout(peer.retryTimer);
    detachLink(peer, true);
    const audio = remoteAudio.get(socketId);
    if (audio) {
      audio.close();
      remoteAudio.delete(socketId);
    }
  }

  function onLinkEvent(link: PeerLink, ev: LinkEvent) {
    const peer = [...peers.values()].find((p) => p.link === link);
    if (ev.type === 'closed') {
      if (pendingLinks.get(link.remoteId) === link) pendingLinks.delete(link.remoteId);
      if (!peer) return;
      detachLink(peer, false);
      if (usersRef.value.some((u) => u.socketId === peer.socketId)) {
        setPeerConnectionState(peer.socketId, 'disconnected');
        // Only the dialing side rebuilds; the other side waits to be called back.
        peer.retryDelay = RETRY_MIN_MS;
        scheduleRedial(peer);
      }
      return;
    }
    if (!peer) return;
    const packet = decodePacket(ev.data);
    if (!packet) return;

    if (packet.kind === 'audio') {
      if (ev.type !== 'datagram') return;
      let audio = remoteAudio.get(peer.socketId);
      if (!audio) {
        audio = deps.createRemoteAudio(ensureAudioEngine());
        remoteAudio.set(peer.socketId, audio);
        updateRemoteVolume(peer.socketId);
        if (audioEngine?.suspended) isAudioPlaybackBlocked.value = true;
      }
      audio.push(packet);
    } else if (packet.kind === 'video') {
      if (ev.type !== 'message') return;
      receiverFor(peer, packet.track).push(packet);
    } else if (packet.op === 'keyframe') {
      videoSenders[packet.track]?.requestKeyframe(peer.socketId);
    } else if (packet.op === 'stopped') {
      dropReceiver(peer, packet.track);
    }
  }

  // ==========================================
  // CONNECTION HEALTH
  // ==========================================
  // A raw "not connected" state is far too noisy to show directly - every reconnect passes
  // through 'connecting'. So a peer only counts as troubled once it has been continuously
  // unhealthy for longer than the grace period below, which is what distinguishes
  // "reconnecting, as designed" from "this call is actually broken".
  const CONNECTION_TROUBLE_GRACE_MS = 8000;
  const peerConnectionStates = ref<Map<string, LinkState>>(new Map());
  const troubledPeerIds = ref<string[]>([]);
  const hasConnectionTrouble = ref(false);
  const unhealthySince = new Map<string, number>();
  let troubleInterval: number | null = null;

  function evaluateConnectionTrouble() {
    const now = Date.now();
    const troubled: string[] = [];
    unhealthySince.forEach((since, socketId) => {
      if (now - since >= CONNECTION_TROUBLE_GRACE_MS) troubled.push(socketId);
    });

    const changed =
      troubled.length !== troubledPeerIds.value.length ||
      troubled.some((id) => !troubledPeerIds.value.includes(id));
    if (changed) {
      troubledPeerIds.value = troubled;
      hasConnectionTrouble.value = troubled.length > 0;
    }

    if (unhealthySince.size === 0 && troubleInterval !== null) {
      clearInterval(troubleInterval);
      troubleInterval = null;
    }
  }

  function setPeerConnectionState(targetSocketId: string, state: LinkState) {
    if (peerConnectionStates.value.get(targetSocketId) !== state) {
      const next = new Map(peerConnectionStates.value);
      next.set(targetSocketId, state);
      peerConnectionStates.value = next;
    }

    if (state === 'connected') {
      unhealthySince.delete(targetSocketId);
    } else if (!unhealthySince.has(targetSocketId)) {
      unhealthySince.set(targetSocketId, Date.now());
      if (troubleInterval === null && typeof window !== 'undefined') {
        troubleInterval = window.setInterval(evaluateConnectionTrouble, 2000);
      }
    }
    evaluateConnectionTrouble();
  }

  function forgetPeerConnectionState(targetSocketId: string) {
    unhealthySince.delete(targetSocketId);
    if (peerConnectionStates.value.has(targetSocketId)) {
      const next = new Map(peerConnectionStates.value);
      next.delete(targetSocketId);
      peerConnectionStates.value = next;
    }
    evaluateConnectionTrouble();
  }

  // ==========================================
  // AUDIO
  // ==========================================
  let audioEngine: AudioEngineLike | null = null;
  let audioSender: AudioSenderLike | null = null;
  /** Playback per remote peer (real or dummy), by socket id. */
  const remoteAudio = new Map<string, RemoteAudioLike>();

  function ensureAudioEngine(): AudioEngineLike {
    if (!audioEngine) audioEngine = deps.createAudioEngine();
    return audioEngine;
  }

  // Whether remote audio is held back by the browser's autoplay policy (the AudioContext
  // is suspended until the user interacts with the page) - surfaced so the UI can prompt
  // for a tap.
  const isAudioPlaybackBlocked = ref(false);

  function unlockBlockedAudioPlayback() {
    if (!audioEngine || !audioEngine.suspended) {
      isAudioPlaybackBlocked.value = false;
      return;
    }
    audioEngine.resume().then(
      () => (isAudioPlaybackBlocked.value = !!audioEngine?.suspended),
      () => (isAudioPlaybackBlocked.value = true)
    );
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', unlockBlockedAudioPlayback);
    window.addEventListener('keydown', unlockBlockedAudioPlayback);
  }

  /** Voice goes only to peers who could hear it: in range, and not deafened. */
  function shouldSendAudio(socketId: string) {
    const user = usersRef.value.find((u) => u.socketId === socketId);
    return !!user && !user.isDeafened && isWithinProximityRange(user);
  }

  function sendAudio(codec: AudioCodec, seq: number, payload: Uint8Array) {
    const packet = encodeAudio(codec, seq, payload);
    for (const peer of peers.values()) {
      if (peer.link && shouldSendAudio(peer.socketId)) peer.link.sendDatagram(packet);
    }
  }

  // Voice Activity Detection to highlight avatar when speaking
  let vadCtx: AudioContext | null = null;
  let analyserNode: AnalyserNode | null = null;
  let vadInterval: number | null = null;
  let isCurrentlySpeaking = false;

  const MAX_AUDIO_DISTANCE = 4; // Tiles

  /**
   * Per-listener volume trim, socketId -> multiplier. 1 is untouched; below 1 turns someone
   * down, above 1 turns them up relative to what proximity would otherwise give.
   */
  const perUserVolume = ref<Record<string, number>>({});

  /** Whether distance attenuates volume at all. Off = a flat level for everyone in range. */
  const proximityVolumeEnabled = ref(true);

  function clampVolume(v: number): number {
    return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  }

  function setUserVolume(socketId: string, gain: number) {
    perUserVolume.value = { ...perUserVolume.value, [socketId]: Math.max(0, Math.min(2, gain)) };
    updateRemoteVolume(socketId);
  }

  function getUserVolume(socketId: string): number {
    return perUserVolume.value[socketId] ?? 1;
  }

  function setProximityVolumeEnabled(enabled: boolean) {
    proximityVolumeEnabled.value = enabled;
    updateAllRemoteVolumes();
  }

  async function initLocalAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localAudioStream.value = stream;
      isMicAvailable.value = true;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMutedRef.value;
      });

      setupVoiceActivityDetection(stream);

      audioSender?.stop();
      audioSender = deps.createAudioSender(ensureAudioEngine(), sendAudio);
      audioSender.enabled = !isMutedRef.value;
      await audioSender.start(stream).catch((err) => console.error('Could not start sending audio:', err));

      return stream;
    } catch (err) {
      console.warn('Microphone access denied or unavailable:', err);
      isMicAvailable.value = false;
      return null;
    }
  }

  function setupVoiceActivityDetection(stream: MediaStream) {
    try {
      vadCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = vadCtx.createMediaStreamSource(stream);
      analyserNode = vadCtx.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      const bufferLength = analyserNode.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      vadInterval = window.setInterval(() => {
        if (!analyserNode || isMutedRef.value) {
          if (isCurrentlySpeaking) {
            isCurrentlySpeaking = false;
            emitSpeakingState(false);
          }
          return;
        }

        analyserNode.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const speakingNow = average > 18; // Threshold

        if (speakingNow !== isCurrentlySpeaking) {
          isCurrentlySpeaking = speakingNow;
          emitSpeakingState(speakingNow);
        }
      }, 150);
    } catch (e) {
      console.error('Error setting up Voice Activity Detection:', e);
    }
  }

  function emitSpeakingState(speaking: boolean) {
    if (socketRef.value) {
      socketRef.value.emit('user:update_profile', { isSpeaking: speaking });
    }
  }

  // Mute: stop encoding entirely, so a muted mic sends nothing at all.
  watch(isMutedRef, (muted) => {
    if (localAudioStream.value) {
      localAudioStream.value.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    if (audioSender) audioSender.enabled = !muted;
    if (muted && isCurrentlySpeaking) {
      isCurrentlySpeaking = false;
      emitSpeakingState(false);
    }
  });

  watch(isDeafenedRef, () => {
    updateAllRemoteVolumes();
  });

  // Position / User changes -> update volumes and who gets our video
  watch(
    [() => currentUserRef.value.position, () => currentUserRef.value.currentZoneId, usersRef],
    () => {
      updateAllRemoteVolumes();
      updatePeerVideoConnections();
      pruneStaleScreenShares();
    },
    { deep: true }
  );

  // A peer's announce arrives as a plain profile update; (re)connect when one changes.
  watch(
    () => usersRef.value.map((u) => `${u.socketId}:${u.media?.endpointId ?? ''}`).join(','),
    () => syncPeerConnections()
  );

  // Shared distance/private-zone gate used by both audio volume and video connection proximity.
  // Deliberately ignores mute/deafen state - those affect audio only, never whether video connects.
  function isWithinProximityRange(targetUser: User): boolean {
    const me = currentUserRef.value;
    if (!me || !targetUser) return false;

    const myZone = me.currentZoneId;
    const targetZone = targetUser.currentZoneId;

    if (myZone && targetZone) {
      return myZone === targetZone;
    } else if (myZone || targetZone) {
      return false;
    }

    const dist = Math.hypot(me.position.x - targetUser.position.x, me.position.y - targetUser.position.y);
    return dist <= MAX_AUDIO_DISTANCE;
  }

  function calculateProximityVolume(targetUser: User): number {
    const me = currentUserRef.value;
    if (!me || !targetUser) return 0;

    if (isDeafenedRef.value) return 0;
    if (targetUser.isMuted) return 0;

    if (!isWithinProximityRange(targetUser)) return 0;

    // Per-listener trim, applied as a multiplier on top of whatever the room decides, so it
    // survives walking around rather than being a one-off absolute level.
    const gain = perUserVolume.value[targetUser.socketId] ?? 1;

    // With proximity volume switched off, anyone you can hear at all, you hear at full level.
    if (!proximityVolumeEnabled.value) return clampVolume(gain);

    // Private Zone: both inside the same zone counts as full volume regardless of distance
    if (me.currentZoneId && targetUser.currentZoneId) return clampVolume(gain);

    // Both on main open floor -> linear distance attenuation (1.0 at distance 0, 0.0 at MAX_AUDIO_DISTANCE)
    const dist = Math.hypot(me.position.x - targetUser.position.x, me.position.y - targetUser.position.y);
    const rawVolume = 1 - dist / MAX_AUDIO_DISTANCE;
    return clampVolume(rawVolume * gain);
  }

  function updateRemoteVolume(targetSocketId: string) {
    const audio = remoteAudio.get(targetSocketId);
    if (!audio) return;
    const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
    audio.volume = targetUser ? calculateProximityVolume(targetUser) : 0;
  }

  function updateAllRemoteVolumes() {
    syncDummyProximity();
    remoteAudio.forEach((_, socketId) => updateRemoteVolume(socketId));
  }

  // ==========================================
  // VIDEO
  // ==========================================
  const videoSenders: Record<VideoTrackKind, VideoSenderLike | null> = { camera: null, screen: null };
  /** Subscriptions whose stream is still being opened, as `${kind}:${socketId}`. */
  const openingStreams = new Set<string>();

  const isScreenSharing = ref(false);
  const remoteScreenStreams = ref<Map<string, MediaStream>>(new Map());
  // Peers we have actually observed flagged as screen sharing (see pruneStaleScreenShares).
  const seenSharing = new Set<string>();

  const tilesFor = (kind: VideoTrackKind) => (kind === 'camera' ? remoteVideoStreams : remoteScreenStreams);

  function setTile(kind: VideoTrackKind, socketId: string, stream: MediaStream | null) {
    const tiles = tilesFor(kind);
    if (!stream && !tiles.value.has(socketId)) return;
    const next = new Map(tiles.value);
    if (stream) next.set(socketId, stream);
    else next.delete(socketId);
    tiles.value = next;
  }

  function receiverFor(peer: Peer, kind: VideoTrackKind): VideoReceiverLike {
    let receiver = peer.receivers.get(kind);
    if (!receiver) {
      const created = deps.createVideoReceiver(
        () => peer.control?.send(encodeControl('keyframe', kind)),
        () => {
          if (peer.receivers.get(kind) === created) setTile(kind, peer.socketId, created.stream);
        }
      );
      receiver = created;
      peer.receivers.set(kind, receiver);
    }
    return receiver;
  }

  function dropReceiver(peer: Peer, kind: VideoTrackKind) {
    const receiver = peer.receivers.get(kind);
    if (receiver) {
      receiver.close();
      peer.receivers.delete(kind);
    }
    setTile(kind, peer.socketId, null);
  }

  /** Whether `peer` should be receiving our `kind` track right now. */
  function wantsVideo(kind: VideoTrackKind, peer: Peer): boolean {
    if (!peer.link) return false;
    const user = usersRef.value.find((u) => u.socketId === peer.socketId);
    if (!user) return false;
    // Screen share goes to everyone in the space; camera only to people in range.
    return kind === 'screen' ? isScreenSharing.value : isVideoOn.value && isWithinProximityRange(user);
  }

  async function subscribe(kind: VideoTrackKind, peer: Peer) {
    const key = `${kind}:${peer.socketId}`;
    const link = peer.link;
    if (!link || openingStreams.has(key)) return;
    openingStreams.add(key);
    try {
      const out = await link.openStream(PRIORITY[kind], VIDEO_QUEUE);
      const sender = videoSenders[kind];
      if (sender && peer.link === link && wantsVideo(kind, peer)) sender.subscribe(peer.socketId, out);
      else out.close();
    } catch (err) {
      console.warn(`Could not open ${kind} stream to ${peer.socketId}:`, err);
    } finally {
      openingStreams.delete(key);
    }
  }

  function unsubscribe(kind: VideoTrackKind, peer: Peer) {
    const sender = videoSenders[kind];
    if (!sender?.has(peer.socketId)) return;
    sender.unsubscribe(peer.socketId);
    peer.control?.send(encodeControl('stopped', kind));
  }

  // Start/stop sending each of our video tracks per peer, by proximity (camera) or
  // presence (screen). Mirrors how audio volume attenuates with distance, but for video we
  // stop sending entirely, which is what saves the bandwidth.
  function updatePeerVideoConnections() {
    for (const kind of ['camera', 'screen'] as const) {
      const sender = videoSenders[kind];
      if (!sender) continue;
      for (const peer of peers.values()) {
        const wanted = wantsVideo(kind, peer);
        if (wanted && !sender.has(peer.socketId)) void subscribe(kind, peer);
        else if (!wanted && sender.has(peer.socketId)) unsubscribe(kind, peer);
      }
    }
  }

  function stopVideoSender(kind: VideoTrackKind) {
    const sender = videoSenders[kind];
    if (!sender) return;
    for (const socketId of sender.subscriberIds) {
      peers.get(socketId)?.control?.send(encodeControl('stopped', kind));
    }
    sender.stop();
    videoSenders[kind] = null;
  }

  async function toggleCamera() {
    if (isVideoOn.value) {
      stopVideoSender('camera');
      if (localVideoStream.value) {
        localVideoStream.value.getTracks().forEach((track) => track.stop());
        localVideoStream.value = null;
      }
      isVideoOn.value = false;
      currentVideoDeviceId.value = null;

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isVideoOn: false });
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 30 } },
          audio: false,
        });
        localVideoStream.value = stream;
        isVideoOn.value = true;
        currentVideoDeviceId.value = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

        // Device labels are only populated after permission is granted
        refreshVideoDevices();

        const track = stream.getVideoTracks()[0];
        if (track) {
          videoSenders.camera = deps.createVideoSender('camera', track, CAMERA_PROFILE);
          videoSenders.camera.start();
          updatePeerVideoConnections();
        }

        if (socketRef.value) {
          socketRef.value.emit('user:update_profile', { isVideoOn: true });
        }
      } catch (err) {
        console.warn('Camera access denied or unavailable:', err);
        isVideoOn.value = false;
      }
    }
  }

  // Swap the active camera device; the encoder keeps running, so viewers see no reconnect.
  async function switchCamera(deviceId?: string) {
    if (!isVideoOn.value) return;

    let targetDeviceId = deviceId ?? null;
    if (!targetDeviceId) {
      if (availableVideoDevices.value.length < 2) return;
      const currentIndex = availableVideoDevices.value.findIndex((d) => d.deviceId === currentVideoDeviceId.value);
      const nextIndex = (currentIndex + 1) % availableVideoDevices.value.length;
      targetDeviceId = availableVideoDevices.value[nextIndex].deviceId;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: targetDeviceId },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { max: 30 },
        },
        audio: false,
      });

      const newTrack = stream.getVideoTracks()[0];
      if (newTrack) videoSenders.camera?.replaceTrack(newTrack);

      const oldStream = localVideoStream.value;
      localVideoStream.value = stream;
      currentVideoDeviceId.value = newTrack?.getSettings().deviceId ?? targetDeviceId;
      if (oldStream) {
        oldStream.getTracks().forEach((track) => track.stop());
      }
    } catch (err) {
      console.warn('Failed to switch camera device:', err);
    }
  }

  // A sharer whose share ends without a clean signal (tab discarded, browser crash) would
  // leave a frozen screen tile up. The server broadcasts isScreenSharing on every user, so
  // treat a true -> false transition of that flag as authoritative and drop the tile.
  function pruneStaleScreenShares() {
    const myId = currentUserRef.value.socketId;

    usersRef.value.forEach((u) => {
      if (u.isScreenSharing && u.socketId !== myId) seenSharing.add(u.socketId);
    });

    const stale: string[] = [];
    remoteScreenStreams.value.forEach((_, socketId) => {
      const sharer = usersRef.value.find((u) => u.socketId === socketId);
      if (!sharer || (!sharer.isScreenSharing && seenSharing.has(socketId))) stale.push(socketId);
    });
    stale.forEach((socketId) => {
      seenSharing.delete(socketId);
      const peer = peers.get(socketId);
      if (peer) dropReceiver(peer, 'screen');
      else setTile('screen', socketId, null);
    });
  }

  async function toggleScreenShare() {
    if (isScreenSharing.value) {
      stopVideoSender('screen');
      if (localScreenStream.value) {
        localScreenStream.value.getTracks().forEach((track) => track.stop());
        localScreenStream.value = null;
      }
      isScreenSharing.value = false;

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isScreenSharing: false });
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 15 } },
        audio: false,
      });
      localScreenStream.value = stream;
      isScreenSharing.value = true;

      const track = stream.getVideoTracks()[0];
      // Auto-stop when the user ends the share via the browser's native "Stop sharing" control
      track?.addEventListener('ended', () => {
        if (isScreenSharing.value) toggleScreenShare();
      });
      if (track) {
        (track as any).contentHint = 'detail';
        videoSenders.screen = deps.createVideoSender('screen', track, SCREEN_PROFILE);
        videoSenders.screen.start();
        updatePeerVideoConnections();
      }

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isScreenSharing: true });
      }
    } catch (err) {
      console.warn('Screen share cancelled or unavailable:', err);
      isScreenSharing.value = false;
    }
  }

  // ==========================================
  // DUMMY (TEST) USERS
  // ==========================================
  // Dummy users exist only in server memory - there is no browser on the other end, so the
  // admin's own client synthesises their media locally: a quiet tone for audio and an
  // animated canvas for video. Both are registered in the same places a real peer's media
  // would be, so proximity volume, the video dock and the per-user volume menu all work on a
  // dummy without knowing it is fake.
  type DummyMedia = {
    osc: OscillatorNode | null;
    canvas: HTMLCanvasElement;
    videoStream: MediaStream;
    timer: number;
  };
  const dummyMedia = new Map<string, DummyMedia>();

  function ensureDummyMedia(user: User) {
    if (dummyMedia.has(user.socketId)) return;
    if (typeof window === 'undefined') return;

    try {
      let hash = 0;
      for (const ch of user.socketId) hash = (hash * 31 + ch.charCodeAt(0)) % 997;

      const remote = deps.createRemoteAudio(ensureAudioEngine());
      remoteAudio.set(user.socketId, remote);
      let osc: OscillatorNode | null = null;
      const ctx = audioEngine?.ctx;
      if (ctx && remote.input) {
        // Deliberately soft - this is a test signal, not something to be startled by.
        const tone = ctx.createGain();
        tone.gain.value = 0.04;
        osc = ctx.createOscillator();
        osc.type = 'sine';
        // Derive the pitch from the id so several dummies are distinguishable by ear.
        osc.frequency.value = 180 + (hash % 12) * 20;
        osc.connect(tone);
        tone.connect(remote.input);
        osc.start();
      }

      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const videoStream = (canvas as any).captureStream
        ? (canvas as HTMLCanvasElement).captureStream(10)
        : new MediaStream();

      const hue = hash % 360;
      let frame = 0;
      const draw = () => {
        const c = canvas.getContext('2d');
        if (!c) return;
        frame += 1;
        c.fillStyle = `hsl(${hue}, 45%, ${18 + 6 * Math.sin(frame / 6)}%)`;
        c.fillRect(0, 0, canvas.width, canvas.height);
        c.fillStyle = `hsl(${hue}, 70%, 60%)`;
        const barCount = 12;
        for (let i = 0; i < barCount; i++) {
          const h = 20 + 60 * Math.abs(Math.sin(frame / 8 + i / 2));
          c.fillRect(12 + i * 25, canvas.height - 40 - h, 16, h);
        }
        c.fillStyle = '#f8fafc';
        c.font = 'bold 18px sans-serif';
        c.fillText(user.name, 12, 32);
        c.font = 'bold 12px sans-serif';
        c.fillText('TEST SIGNAL', 12, 52);
      };
      draw();
      const timer = window.setInterval(draw, 100);

      dummyMedia.set(user.socketId, { osc, canvas, videoStream, timer });
      if (audioEngine?.suspended) isAudioPlaybackBlocked.value = true;
      // Proximity decides whether the tone is audible and whether the video tile exists at
      // all - a freshly placed dummy you are standing away from must start silent/hidden.
      syncDummyProximity();
    } catch (err) {
      console.warn('Could not create test user media:', err);
    }
  }

  function removeDummyMedia(socketId: string) {
    const media = dummyMedia.get(socketId);
    if (!media) return;
    dummyMedia.delete(socketId);

    clearInterval(media.timer);
    try {
      media.osc?.stop();
    } catch (_) {}
    media.osc?.disconnect();
    media.videoStream.getTracks().forEach((t) => t.stop());

    remoteAudio.get(socketId)?.close();
    remoteAudio.delete(socketId);
    setTile('camera', socketId, null);
  }

  /** A dummy's video tile follows proximity, the local equivalent of a peer unsubscribing us. */
  function syncDummyProximity() {
    dummyMedia.forEach((media, socketId) => {
      const user = usersRef.value.find((u) => u.socketId === socketId);
      const inRange = user ? isWithinProximityRange(user) : false;
      const hasTile = remoteVideoStreams.value.has(socketId);
      if (inRange && !hasTile) setTile('camera', socketId, media.videoStream);
      else if (!inRange && hasTile) setTile('camera', socketId, null);
    });
  }

  // ==========================================
  // PEER SET
  // ==========================================
  // Called whenever the user list changes (join, leave, announce). Reconciles the peer set
  // with it: dials new peers, picks up links that arrived early, and tears down departed ones.
  function syncPeerConnections() {
    const myId = currentUserRef.value.socketId;
    if (!myId) return;
    ensureTransport();
    announce();

    const present = new Set(usersRef.value.map((u) => u.socketId));

    usersRef.value.forEach((user) => {
      if (user.socketId === myId) return;
      // No real peer on the other end - synthesise their signal locally instead.
      if (user.isDummy) {
        ensureDummyMedia(user);
        return;
      }
      if (!transport) return;

      const media = verifiedMedia(user);
      let peer = peers.get(user.socketId);
      if (peer && (!media || peer.endpointId !== media.endpointId)) {
        removePeer(user.socketId);
        peer = undefined;
      }
      if (!media) {
        // Not announced (yet): their endpoint may still be starting.
        if (!peerConnectionStates.value.has(user.socketId)) setPeerConnectionState(user.socketId, 'new');
        return;
      }
      if (!peer) {
        peer = {
          socketId: user.socketId,
          endpointId: media.endpointId,
          relay: media.relay,
          link: null,
          control: null,
          dialing: false,
          retryTimer: null,
          retryDelay: RETRY_MIN_MS,
          receivers: new Map(),
        };
        peers.set(user.socketId, peer);
        setPeerConnectionState(user.socketId, 'connecting');
        const early = pendingLinks.get(media.endpointId);
        if (early) {
          pendingLinks.delete(media.endpointId);
          void attachLink(peer, early);
        }
      }
      if (!peer.link) void dial(peer);
    });

    peers.forEach((_, socketId) => {
      if (!present.has(socketId)) {
        removePeer(socketId);
        forgetPeerConnectionState(socketId);
      }
    });
    peerConnectionStates.value.forEach((_, socketId) => {
      if (!present.has(socketId)) forgetPeerConnectionState(socketId);
    });

    dummyMedia.forEach((_, socketId) => {
      if (!usersRef.value.some((u) => u.socketId === socketId && u.isDummy)) {
        removeDummyMedia(socketId);
      }
    });

    updatePeerVideoConnections();
    // Someone who left while sharing, or who stopped sharing, must not keep a tile in the dock.
    pruneStaleScreenShares();
  }

  onUnmounted(() => {
    disposed = true;
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener?.('devicechange', refreshVideoDevices);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', unlockBlockedAudioPlayback);
      window.removeEventListener('keydown', unlockBlockedAudioPlayback);
    }
    if (vadInterval) clearInterval(vadInterval);
    if (troubleInterval !== null) clearInterval(troubleInterval);
    vadCtx?.close().catch(() => {});
    stopVideoSender('camera');
    stopVideoSender('screen');
    audioSender?.stop();
    [localAudioStream.value, localVideoStream.value, localScreenStream.value].forEach((s) =>
      s?.getTracks().forEach((track) => track.stop())
    );
    Array.from(dummyMedia.keys()).forEach(removeDummyMedia);
    Array.from(peers.keys()).forEach(removePeer);
    pendingLinks.forEach((link) => link.close());
    pendingLinks.clear();
    remoteAudio.forEach((a) => a.close());
    remoteAudio.clear();
    audioEngine?.close();
    transport?.close();
  });

  return {
    initLocalAudio,
    toggleCamera,
    switchCamera,
    toggleScreenShare,
    refreshVideoDevices,
    syncPeerConnections,
    updateAllRemoteVolumes,
    calculateProximityVolume,
    isMicAvailable,
    isVideoOn,
    isScreenSharing,
    localAudioStream,
    localVideoStream,
    remoteVideoStreams,
    localScreenStream,
    remoteScreenStreams,
    availableVideoDevices,
    currentVideoDeviceId,
    isAudioPlaybackBlocked,
    unlockBlockedAudioPlayback,
    hasConnectionTrouble,
    troubledPeerIds,
    peerConnectionStates,
    perUserVolume,
    setUserVolume,
    getUserVolume,
    proximityVolumeEnabled,
    setProximityVolumeEnabled,
    // Read-only escape hatch for integration tests. Not used by any UI component.
    __debugPeers: peers,
    __debugRemoteAudio: remoteAudio,
  };
}
