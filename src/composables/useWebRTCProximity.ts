import { ref, watch, onUnmounted } from 'vue';
import type { Socket } from 'socket.io-client';
import type { User } from '../types';

// Public STUN is enough to punch through a typical home router, but it cannot help behind
// symmetric NAT or a restrictive corporate firewall - those need a TURN relay, and a relay
// needs credentials, so it can't be hardcoded here. Deployments configure their own via env:
//
//   VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
//     Full RTCIceServer[] as JSON - replaces the defaults entirely.
//   VITE_TURN_URLS='turn:turn.example.com:3478,turns:turn.example.com:5349'
//   VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL
//     Shorthand for the common case - appends a TURN entry to the default STUN servers.
//
// Anything malformed falls back to the STUN defaults rather than leaving the app with no ICE
// configuration at all (which would break every connection instead of just the hard ones).
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function resolveIceServers(): RTCIceServer[] {
  const env = (import.meta as any).env ?? {};

  const raw = (env.VITE_ICE_SERVERS ?? '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as RTCIceServer[];
      console.warn('VITE_ICE_SERVERS must be a non-empty JSON array; using default STUN servers.');
    } catch (err) {
      console.warn('VITE_ICE_SERVERS is not valid JSON; using default STUN servers:', err);
    }
  }

  const turnUrls = (env.VITE_TURN_URLS ?? '')
    .split(',')
    .map((u: string) => u.trim())
    .filter(Boolean);
  if (turnUrls.length === 0) return DEFAULT_ICE_SERVERS;

  return [
    ...DEFAULT_ICE_SERVERS,
    {
      urls: turnUrls,
      username: env.VITE_TURN_USERNAME || undefined,
      credential: env.VITE_TURN_CREDENTIAL || undefined,
    },
  ];
}

const ICE_SERVERS = resolveIceServers();

export function useWebRTCProximity(
  socketRef: { value: Socket | null },
  currentUserRef: { value: User },
  usersRef: { value: User[] },
  isMutedRef: { value: boolean },
  isDeafenedRef: { value: boolean }
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

  // Peer Connections map: socketId -> RTCPeerConnection
  const peerConnections = new Map<string, RTCPeerConnection>();
  // Audio elements map: socketId -> HTMLAudioElement
  const remoteAudioElements = new Map<string, HTMLAudioElement>();
  // Pending ICE candidates buffer if remote description is not set yet
  const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  // Serializes every negotiation step (both locally-initiated renegotiation via
  // connectToUser and incoming signals via handleSignal) per peer connection, so they can
  // never interleave and race each other's signalingState transitions. Without this, two
  // renegotiations for the same pair firing close together - e.g. two people's cameras
  // both turning on around the same moment, which gets more likely with every additional
  // participant - could hit a second collision while still resolving the first, slip past
  // the polite/impolite check, and silently drop an offer/answer with no retry. That
  // showed up as video sometimes just never (re)connecting for a given pair, especially in
  // calls with 3+ people where more renegotiations overlap.
  const negotiationQueues = new Map<string, Promise<void>>();
  function enqueueNegotiation(key: string, task: () => Promise<void>): Promise<void> {
    const prev = negotiationQueues.get(key) || Promise.resolve();
    const next = prev.then(task).catch((err) => {
      console.error(`Negotiation error for ${key}:`, err);
    });
    negotiationQueues.set(key, next);
    return next;
  }

  // Connection health, surfaced so the UI can actually tell the user their call is broken.
  // Previously a connection that failed and kept failing was only ever console.error'd, so
  // from the user's side it just looked like everyone had gone quiet for no reason.
  //
  // A raw "not connected" state is far too noisy to show directly - every renegotiation and
  // every post-failure rebuild passes through 'connecting', and 'disconnected' is usually a
  // blip the ICE agent recovers from on its own. So a peer only counts as troubled once it
  // has been continuously unhealthy for longer than the grace period below, which is what
  // distinguishes "reconnecting, as designed" from "this call is actually broken".
  const CONNECTION_TROUBLE_GRACE_MS = 8000;
  const peerConnectionStates = ref<Map<string, RTCPeerConnectionState>>(new Map());
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

    // Only touch the refs on an actual change so this poll doesn't invalidate anything
    // downstream every couple of seconds.
    const changed =
      troubled.length !== troubledPeerIds.value.length ||
      troubled.some((id) => !troubledPeerIds.value.includes(id));
    if (changed) {
      troubledPeerIds.value = troubled;
      hasConnectionTrouble.value = troubled.length > 0;
    }

    // The poll only exists to let a peer cross the grace threshold while nothing else is
    // happening; with nothing pending there's nothing left for it to discover.
    if (unhealthySince.size === 0 && troubleInterval !== null) {
      clearInterval(troubleInterval);
      troubleInterval = null;
    }
  }

  function setPeerConnectionState(targetSocketId: string, state: RTCPeerConnectionState) {
    const next = new Map(peerConnectionStates.value);
    next.set(targetSocketId, state);
    peerConnectionStates.value = next;

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

  // Whether any remote peer's audio element is currently blocked by the browser's autoplay
  // policy (play() rejected) - surfaced so the UI can prompt for a tap to unblock sound.
  const isAudioPlaybackBlocked = ref(false);

  // Browsers commonly reject audio.play() for an <audio> element that's created and played
  // asynchronously (e.g. when a remote track arrives well after the page loaded) unless it
  // happens inside a direct user-gesture handler. This retries playback on the next tap/
  // click/keypress anywhere on the page, which is exactly such a gesture - this is the
  // standard "unlock autoplay" pattern and fixes the classic "I can see they're talking but
  // hear nothing" symptom that only affects some browsers/devices.
  function unlockBlockedAudioPlayback() {
    const pausedElements = Array.from(remoteAudioElements.values()).filter((audio) => audio.paused);
    if (pausedElements.length === 0) {
      isAudioPlaybackBlocked.value = false;
      return;
    }

    // play() is async, so the flag must wait for every attempt to actually settle -
    // updating it synchronously right after calling play() would just re-read the stale
    // "still blocked" state from before this attempt.
    const attempts = pausedElements.map((audio) =>
      audio.play().then(
        () => true,
        () => false
      )
    );
    Promise.all(attempts).then((results) => {
      isAudioPlaybackBlocked.value = results.some((succeeded) => !succeeded);
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', unlockBlockedAudioPlayback);
    window.addEventListener('keydown', unlockBlockedAudioPlayback);
  }

  // Screen share uses its own dedicated peer connection per peer (kept separate from the
  // camera/mic connection) so a sharer's video track never collides with their camera track.
  const isScreenSharing = ref(false);
  const remoteScreenStreams = ref<Map<string, MediaStream>>(new Map());
  const screenPeerConnections = new Map<string, RTCPeerConnection>();
  const screenPendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  // Peers we have actually observed flagged as screen sharing (see pruneStaleScreenShares).
  const seenSharing = new Set<string>();

  // Audio Context for Voice Activity Detection (VAD)
  let audioCtx: AudioContext | null = null;
  let analyserNode: AnalyserNode | null = null;
  let vadInterval: number | null = null;
  let isCurrentlySpeaking = false;

  const MAX_AUDIO_DISTANCE = 4; // Tiles

  /**
   * Per-listener volume trim, socketId -> multiplier. 1 is untouched; below 1 turns someone
   * down, above 1 turns them up relative to what proximity would otherwise give.
   *
   * Deliberately a multiplier rather than an absolute level: an absolute one would be
   * overwritten the moment either of you moved. It is also session-scoped, keyed by socket
   * id, because that is what the audio elements are keyed by - a preference that outlived
   * the session would need to be keyed by user id and reconciled on every join.
   */
  const perUserVolume = ref<Record<string, number>>({});

  /** Whether distance attenuates volume at all. Off = a flat level for everyone in range. */
  const proximityVolumeEnabled = ref(true);

  /** An <audio> element's volume only accepts 0..1, so a boost can never exceed full scale. */
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

  // 1. Initialize Microphone Audio Stream
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

      // Handle mute state initially
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMutedRef.value;
      });

      setupVoiceActivityDetection(stream);

      // On a fresh page load, the server's init:state (which drives syncPeerConnections)
      // can easily arrive before the mic permission prompt is resolved - the user has to
      // physically click "Allow" first. Any peer connections that got created in the
      // meantime went out with no audio track and would otherwise stay silent forever;
      // attach the track retroactively instead.
      peerConnections.forEach((pc, targetSocketId) => {
        const hasAudioSender = pc.getSenders().some((s) => s.track?.kind === 'audio');
        if (!hasAudioSender) {
          stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
          safeRenegotiate(targetSocketId, pc);
        }
      });

      return stream;
    } catch (err) {
      console.warn('Microphone access denied or unavailable:', err);
      isMicAvailable.value = false;
      return null;
    }
  }

  // Voice Activity Detection to highlight avatar when speaking
  function setupVoiceActivityDetection(stream: MediaStream) {
    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyserNode = audioCtx.createAnalyser();
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

  // Mute / Unmute handler
  watch(isMutedRef, (muted) => {
    if (localAudioStream.value) {
      localAudioStream.value.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    if (muted && isCurrentlySpeaking) {
      isCurrentlySpeaking = false;
      emitSpeakingState(false);
    }
  });

  // Deafen handler
  watch(isDeafenedRef, () => {
    updateAllRemoteVolumes();
  });

  // Position / User changes -> update volumes and auto connect/disconnect camera by proximity
  watch(
    [() => currentUserRef.value.position, () => currentUserRef.value.currentZoneId, usersRef],
    () => {
      updateAllRemoteVolumes();
      updatePeerVideoConnections();
      pruneStaleScreenShares();
    },
    { deep: true }
  );

  // Re-send an offer once the connection is idle - avoids glare if a renegotiation is already in flight
  function safeRenegotiate(targetSocketId: string, pc: RTCPeerConnection) {
    if (pc.signalingState === 'stable') {
      connectToUser(targetSocketId);
      return;
    }
    const retry = () => {
      if (pc.signalingState === 'stable') {
        pc.removeEventListener('signalingstatechange', retry);
        connectToUser(targetSocketId);
      }
    };
    pc.addEventListener('signalingstatechange', retry);
  }

  // Auto connect/disconnect the outgoing camera track per peer based on spatial proximity -
  // mirrors how remote audio volume attenuates with distance, but for video we fully stop
  // sending (and therefore receiving) the track rather than just muting it locally.
  function updatePeerVideoConnections() {
    if (!isVideoOn.value || !localVideoStream.value) return;

    peerConnections.forEach((pc, targetSocketId) => {
      const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
      if (!targetUser) return;

      const inRange = isWithinProximityRange(targetUser);
      const existingSender = pc.getSenders().find((s) => s.track?.kind === 'video');

      if (inRange && !existingSender) {
        localVideoStream.value!.getVideoTracks().forEach((track) => {
          pc.addTrack(track, localVideoStream.value!);
        });
        safeRenegotiate(targetSocketId, pc);
      } else if (!inRange && existingSender) {
        pc.removeTrack(existingSender);
        safeRenegotiate(targetSocketId, pc);
      }
    });
  }

  // Camera Video toggle handler
  async function toggleCamera() {
    if (isVideoOn.value) {
      // Turn off camera
      if (localVideoStream.value) {
        localVideoStream.value.getTracks().forEach((track) => track.stop());
        localVideoStream.value = null;
      }
      isVideoOn.value = false;
      currentVideoDeviceId.value = null;

      // Remove video senders from peer connections and renegotiate so remote viewers
      // actually see the track end, instead of it silently going stale.
      peerConnections.forEach((pc, targetSocketId) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) {
          pc.removeTrack(sender);
          safeRenegotiate(targetSocketId, pc);
        }
      });

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isVideoOn: false });
      }
    } else {
      // Turn on camera
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

        // Add video tracks only to peers currently within proximity range
        peerConnections.forEach((pc, targetSocketId) => {
          const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
          if (!targetUser || !isWithinProximityRange(targetUser)) return;

          stream.getVideoTracks().forEach((track) => {
            pc.addTrack(track, stream);
          });
          // Renegotiate
          connectToUser(targetSocketId);
        });

        if (socketRef.value) {
          socketRef.value.emit('user:update_profile', { isVideoOn: true });
        }
      } catch (err) {
        console.warn('Camera access denied or unavailable:', err);
        isVideoOn.value = false;
      }
    }
  }

  // Swap the active camera device without a full renegotiation (replaces the outgoing
  // track on existing peer connections so remote viewers don't see a reconnect).
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
      peerConnections.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && newTrack) {
          sender.replaceTrack(newTrack);
        }
      });

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

  // 2. WebRTC Peer Connection Helper
  function getOrCreatePeerConnection(targetSocketId: string): RTCPeerConnection {
    if (peerConnections.has(targetSocketId)) {
      return peerConnections.get(targetSocketId)!;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local audio tracks
    if (localAudioStream.value) {
      localAudioStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localAudioStream.value!);
      });
    }

    // Add local video tracks only if the camera is on and this peer is within proximity range
    const targetUserForVideo = usersRef.value.find((u) => u.socketId === targetSocketId);
    if (localVideoStream.value && targetUserForVideo && isWithinProximityRange(targetUserForVideo)) {
      localVideoStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localVideoStream.value!);
      });
    }

    // ICE Candidate
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.value) {
        socketRef.value.emit('webrtc:signal', {
          to: targetSocketId,
          signal: { type: 'candidate', candidate: event.candidate },
        });
      }
    };

    // Track received (remote stream)
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      if (event.track.kind === 'audio') {
        attachRemoteAudioStream(targetSocketId, remoteStream);
      } else if (event.track.kind === 'video') {
        const addStream = () => {
          const m = new Map(remoteVideoStreams.value);
          m.set(targetSocketId, remoteStream);
          remoteVideoStreams.value = m;
        };
        const removeStream = () => {
          const m = new Map(remoteVideoStreams.value);
          m.delete(targetSocketId);
          remoteVideoStreams.value = m;
        };

        // Proximity-based add/removeTrack (see updatePeerVideoConnections) doesn't tear down
        // the transceiver - it renegotiates the same one, which mutes the remote track rather
        // than ending it. Without handling mute/unmute here, a peer walking out of range would
        // leave a frozen/blacked-out tile behind instead of the tile disappearing.
        if (!event.track.muted) {
          addStream();
        }
        event.track.onunmute = addStream;
        event.track.onmute = removeStream;
        event.track.onended = removeStream;
      }
    };

    pc.onconnectionstatechange = () => {
      // A connection we've already torn down (or replaced) can still emit a trailing state
      // change; letting that through would report health for a connection nobody is using.
      if (peerConnections.get(targetSocketId) !== pc) return;
      setPeerConnectionState(targetSocketId, pc.connectionState);

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // Terminal - rebuild immediately rather than leaving the peer silent until some
        // unrelated event (someone else joining/leaving) happens to call
        // syncPeerConnections() again.
        removePeerConnection(targetSocketId);
        reconnectToPeerIfInitiator(targetSocketId);
      } else if (pc.connectionState === 'disconnected') {
        // Often transient (a brief network blip) and the ICE agent recovers on its own -
        // only force a rebuild if it's still stuck after a few seconds.
        setTimeout(() => {
          if (peerConnections.get(targetSocketId) === pc && pc.connectionState === 'disconnected') {
            removePeerConnection(targetSocketId);
            reconnectToPeerIfInitiator(targetSocketId);
          }
        }, 5000);
      }
    };

    peerConnections.set(targetSocketId, pc);
    return pc;
  }

  // Re-establish a connection to a peer after it's been torn down, but only from the side
  // that would have initiated it in the first place (same tiebreak as syncPeerConnections) -
  // otherwise both sides would race to recreate it at once.
  function reconnectToPeerIfInitiator(targetSocketId: string) {
    const myId = currentUserRef.value.socketId;
    const stillPresent = usersRef.value.some((u) => u.socketId === targetSocketId);
    if (!stillPresent) {
      // They're gone, so there is nothing to reconnect to and nothing to warn about - drop
      // the health entry instead of leaving it stuck as permanently "troubled".
      forgetPeerConnectionState(targetSocketId);
      return;
    }
    if (myId < targetSocketId) {
      connectToUser(targetSocketId);
    }
  }

  function attachRemoteAudioStream(targetSocketId: string, stream: MediaStream) {
    let audio = remoteAudioElements.get(targetSocketId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      remoteAudioElements.set(targetSocketId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch((err) => {
      console.warn('Autoplay audio blocked, will retry on next user interaction:', err);
      isAudioPlaybackBlocked.value = true;
    });

    updateRemoteVolume(targetSocketId);
  }

  function removePeerConnection(targetSocketId: string) {
    const pc = peerConnections.get(targetSocketId);
    if (pc) {
      // Unregister before closing so any state change close() emits is recognised as coming
      // from a connection we've already abandoned (see onconnectionstatechange).
      peerConnections.delete(targetSocketId);
      pc.close();
    }
    const audio = remoteAudioElements.get(targetSocketId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudioElements.delete(targetSocketId);
    }
    pendingCandidates.delete(targetSocketId);

    // This was previously missing, which left a permanent frozen "ghost" video tile in
    // VideoDock every time a connection was torn down (ICE failure, reload, or the peer
    // just leaving) - the old MediaStream's tracks stop, but the map entry itself lived on
    // forever since nothing here ever deleted it. A brand new connection to the same
    // person after a reload uses a new socket id, so the stale tile was never overwritten
    // either - it just sat there alongside the real, working reconnect.
    if (remoteVideoStreams.value.has(targetSocketId)) {
      const m = new Map(remoteVideoStreams.value);
      m.delete(targetSocketId);
      remoteVideoStreams.value = m;
    }
  }

  // Screen Share Peer Connection Helper (separate connection so its video track
  // never overwrites the camera video track when both are active for the same peer)
  function getOrCreateScreenPeerConnection(targetSocketId: string): RTCPeerConnection {
    if (screenPeerConnections.has(targetSocketId)) {
      return screenPeerConnections.get(targetSocketId)!;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localScreenStream.value) {
      localScreenStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localScreenStream.value!);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.value) {
        socketRef.value.emit('webrtc:signal', {
          to: targetSocketId,
          signal: { channel: 'screen', type: 'candidate', candidate: event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      const newMap = new Map(remoteScreenStreams.value);
      newMap.set(targetSocketId, remoteStream);
      remoteScreenStreams.value = newMap;

      const dropScreenTile = () => {
        const m = new Map(remoteScreenStreams.value);
        m.delete(targetSocketId);
        remoteScreenStreams.value = m;
      };
      event.track.onended = dropScreenTile;
      // A share that stops without the transceiver being torn down (the sharer removed the
      // track and renegotiated) mutes the remote track rather than ending it - without this
      // the tile would keep showing the last frame it received.
      event.track.onmute = dropScreenTile;
    };

    // Unlike the main audio/video connection, screen share only ever has one possible
    // initiator (whoever is sharing) - so on failure we just re-share to this same viewer,
    // no tiebreak needed. Without this, one viewer's screen share silently stayed broken
    // for the rest of the session after any ICE hiccup, even though the other viewers (and
    // the sharer's own camera/mic connection to that same person) recovered fine.
    const rebuildScreenConnection = () => {
      removeScreenPeerConnection(targetSocketId);
      const stillSharingWithThisPeer =
        isScreenSharing.value && usersRef.value.some((u) => u.socketId === targetSocketId);
      if (stillSharingWithThisPeer) {
        connectScreenToUser(targetSocketId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        rebuildScreenConnection();
      } else if (pc.connectionState === 'disconnected') {
        setTimeout(() => {
          if (screenPeerConnections.get(targetSocketId) === pc && pc.connectionState === 'disconnected') {
            rebuildScreenConnection();
          }
        }, 5000);
      }
    };

    screenPeerConnections.set(targetSocketId, pc);
    return pc;
  }

  function removeScreenPeerConnection(targetSocketId: string) {
    const pc = screenPeerConnections.get(targetSocketId);
    if (pc) {
      pc.close();
      screenPeerConnections.delete(targetSocketId);
    }
    const newMap = new Map(remoteScreenStreams.value);
    newMap.delete(targetSocketId);
    remoteScreenStreams.value = newMap;
    screenPendingCandidates.delete(targetSocketId);
  }

  // A sharer whose share ends without a clean signal - tab discarded/suspended by the OS,
  // browser crash, or simply a stop whose track-ended event never reaches us - would leave a
  // frozen screen tile up for every viewer until ICE eventually gives up, or forever if the
  // connection stays nominally alive. The server already broadcasts isScreenSharing on every
  // user, so treat that flag as the source of truth and drop any screen tile whose owner is
  // no longer sharing.
  function pruneStaleScreenShares() {
    const myId = currentUserRef.value.socketId;

    // Only a true -> false transition counts. A peer's screen track and their profile update
    // are independent socket messages with no ordering guarantee, so if the track happened to
    // arrive first, treating the not-yet-updated flag as authoritative would tear the tile
    // down again the moment any unrelated user update (somebody moving, say) ran this.
    usersRef.value.forEach((u) => {
      if (u.isScreenSharing && u.socketId !== myId) seenSharing.add(u.socketId);
    });

    const stale: string[] = [];
    remoteScreenStreams.value.forEach((_, socketId) => {
      const sharer = usersRef.value.find((u) => u.socketId === socketId);
      if (!sharer || (!sharer.isScreenSharing && seenSharing.has(socketId))) {
        stale.push(socketId);
      }
    });
    if (stale.length === 0) return;

    const next = new Map(remoteScreenStreams.value);
    stale.forEach((socketId) => {
      next.delete(socketId);
      seenSharing.delete(socketId);

      // Both directions of a pair share one screen connection, so it can only be torn down
      // if it isn't still carrying our own outgoing share to that peer.
      const stillCarryingOurShare =
        isScreenSharing.value && usersRef.value.some((u) => u.socketId === socketId);
      if (!stillCarryingOurShare) {
        const pc = screenPeerConnections.get(socketId);
        if (pc) {
          screenPeerConnections.delete(socketId);
          pc.close();
        }
        screenPendingCandidates.delete(socketId);
      }
    });
    remoteScreenStreams.value = next;
  }

  function connectScreenToUser(targetSocketId: string) {
    return enqueueNegotiation(`${targetSocketId}:screen`, async () => {
      const pc = getOrCreateScreenPeerConnection(targetSocketId);
      if (pc.signalingState !== 'stable') {
        return;
      }
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (socketRef.value) {
          socketRef.value.emit('webrtc:signal', {
            to: targetSocketId,
            signal: { channel: 'screen', type: 'offer', sdp: pc.localDescription },
          });
        }
      } catch (err) {
        console.error(`Failed to create screen share offer for ${targetSocketId}:`, err);
      }
    });
  }

  // Start / stop sharing your screen with every currently connected peer
  async function toggleScreenShare() {
    if (isScreenSharing.value) {
      if (localScreenStream.value) {
        localScreenStream.value.getTracks().forEach((track) => track.stop());
        localScreenStream.value = null;
      }
      isScreenSharing.value = false;

      screenPeerConnections.forEach((_, targetSocketId) => removeScreenPeerConnection(targetSocketId));

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

      // Auto-stop when the user ends the share via the browser's native "Stop sharing" control
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (isScreenSharing.value) toggleScreenShare();
      });

      const myId = currentUserRef.value.socketId;
      usersRef.value.forEach((u) => {
        if (u.socketId !== myId) {
          connectScreenToUser(u.socketId);
        }
      });

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isScreenSharing: true });
      }
    } catch (err) {
      console.warn('Screen share cancelled or unavailable:', err);
      isScreenSharing.value = false;
    }
  }

  // 3. Initiate Connection Offer
  function connectToUser(targetSocketId: string) {
    return enqueueNegotiation(targetSocketId, async () => {
      const pc = getOrCreatePeerConnection(targetSocketId);
      if (pc.signalingState !== 'stable') {
        // An offer is already outstanding (or we're mid-answer) for this pair - re-offering
        // now would throw; whatever's already in flight will settle this on its own.
        return;
      }
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (socketRef.value) {
          socketRef.value.emit('webrtc:signal', {
            to: targetSocketId,
            signal: { type: 'offer', sdp: pc.localDescription },
          });
        }
      } catch (err) {
        console.error(`Failed to create offer for ${targetSocketId}:`, err);
      }
    });
  }

  // 4. Handle Incoming WebRTC Signal
  function handleSignal(data: { from: string; signal: any }): Promise<void> {
    const { from, signal } = data;
    if (!from || !signal) return Promise.resolve();

    const isScreenChannel = signal.channel === 'screen';
    // Same queue key as connectToUser/connectScreenToUser for this peer - that's what
    // guarantees an incoming signal and a locally-initiated renegotiation for the same
    // connection never execute interleaved with each other.
    const queueKey = isScreenChannel ? `${from}:screen` : from;

    return enqueueNegotiation(queueKey, async () => {
      const pc = isScreenChannel ? getOrCreateScreenPeerConnection(from) : getOrCreatePeerConnection(from);
      const pendingMap = isScreenChannel ? screenPendingCandidates : pendingCandidates;

      try {
        if (signal.type === 'offer') {
          // Glare: both sides can independently decide to renegotiate at the same moment
          // (e.g. two peers both walking into range simultaneously each call
          // updatePeerVideoConnections and send an offer), so our own offer can already be
          // outstanding when the peer's offer arrives. Without handling this, whichever
          // side's setRemoteDescription() lands second throws, is only console.error'd, and
          // that connection is left stuck in 'have-local-offer' forever - this was a real
          // source of "audio/video sometimes doesn't come back" reports.
          //
          // Fix: standard "perfect negotiation" polite/impolite split, using the same
          // deterministic id comparison already used to decide who initiates in
          // syncPeerConnections. The polite side rolls back its own offer and accepts the
          // incoming one; the impolite side ignores the incoming offer and keeps its own.
          const offerCollision = pc.signalingState !== 'stable';
          if (offerCollision) {
            const isPolite = currentUserRef.value.socketId > from;
            if (!isPolite) {
              return;
            }
            await pc.setLocalDescription({ type: 'rollback' } as any);
          }

          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

          // Process buffered candidate signals
          const pending = pendingMap.get(from);
          if (pending) {
            for (const cand of pending) {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            }
            pendingMap.delete(from);
          }

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          if (socketRef.value) {
            socketRef.value.emit('webrtc:signal', {
              to: from,
              signal: isScreenChannel
                ? { channel: 'screen', type: 'answer', sdp: pc.localDescription }
                : { type: 'answer', sdp: pc.localDescription },
            });
          }
        } else if (signal.type === 'answer') {
          if (pc.signalingState !== 'have-local-offer') {
            // No outstanding offer of ours for this to answer (e.g. we already rolled it
            // back to accept their offer instead in a glare) - nothing to apply.
            return;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        } else if (signal.type === 'candidate') {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            // Buffer candidate until remote description is set
            if (!pendingMap.has(from)) {
              pendingMap.set(from, []);
            }
            pendingMap.get(from)!.push(signal.candidate);
          }
        }
      } catch (err) {
        console.error('Error handling WebRTC signal:', err);
      }
    });
  }

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

  // 5. Dynamic Spatial Proximity Volume Calculation
  function calculateProximityVolume(targetUser: User): number {
    const me = currentUserRef.value;
    if (!me || !targetUser) return 0;

    // If I am deafened, volume is zero
    if (isDeafenedRef.value) return 0;
    // If target user is muted, volume is zero
    if (targetUser.isMuted) return 0;

    if (!isWithinProximityRange(targetUser)) return 0;

    // Per-listener trim, set from the right-click menu on someone's avatar. Applied as a
    // multiplier on top of whatever the room decides, so it survives walking around rather
    // than being a one-off absolute level that distance immediately overrides.
    const gain = perUserVolume.value[targetUser.socketId] ?? 1;

    // With proximity volume switched off the room stops attenuating by distance entirely -
    // anyone you can hear at all, you hear at full level. Range and zone gating still apply,
    // so this makes the space behave like a normal call rather than removing the walls.
    if (!proximityVolumeEnabled.value) return clampVolume(gain);

    // Private Zone: both inside the same zone counts as full volume regardless of distance
    if (me.currentZoneId && targetUser.currentZoneId) return clampVolume(gain);

    // Both on main open floor -> linear distance attenuation (1.0 at distance 0, 0.0 at MAX_AUDIO_DISTANCE)
    const dist = Math.hypot(me.position.x - targetUser.position.x, me.position.y - targetUser.position.y);
    const rawVolume = 1 - dist / MAX_AUDIO_DISTANCE;
    return clampVolume(rawVolume * gain);
  }

  function updateRemoteVolume(targetSocketId: string) {
    const audio = remoteAudioElements.get(targetSocketId);
    if (!audio) return;

    const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
    if (!targetUser) {
      audio.volume = 0;
      return;
    }

    const vol = calculateProximityVolume(targetUser);
    audio.volume = vol;
  }

  function updateAllRemoteVolumes() {
    remoteAudioElements.forEach((audio, socketId) => {
      const targetUser = usersRef.value.find((u) => u.socketId === socketId);
      if (targetUser) {
        audio.volume = calculateProximityVolume(targetUser);
      } else {
        audio.volume = 0;
      }
    });
  }

  // Sync peer connections whenever users list updates
  function syncPeerConnections() {
    const myId = currentUserRef.value.socketId;
    if (!myId) return;

    const currentSocketIds = new Set(usersRef.value.map((u) => u.socketId));

    // Initiate offer to new peers (using socket ID comparison to prevent dual-offer race condition)
    usersRef.value.forEach((otherUser) => {
      if (otherUser.socketId !== myId) {
        if (!peerConnections.has(otherUser.socketId)) {
          // Lower socket ID initiates offer to maintain deterministic signaling
          if (myId < otherUser.socketId) {
            connectToUser(otherUser.socketId);
          }
        }
        // If I'm currently sharing my screen, make sure every peer has a screen connection too
        if (isScreenSharing.value && !screenPeerConnections.has(otherUser.socketId)) {
          connectScreenToUser(otherUser.socketId);
        }
      }
    });

    // Clean up left peers
    peerConnections.forEach((_, socketId) => {
      if (!currentSocketIds.has(socketId)) {
        removePeerConnection(socketId);
        forgetPeerConnectionState(socketId);
      }
    });
    screenPeerConnections.forEach((_, socketId) => {
      if (!currentSocketIds.has(socketId)) {
        removeScreenPeerConnection(socketId);
      }
    });

    // Someone who left while sharing, or who stopped sharing, must not keep a tile in the dock.
    pruneStaleScreenShares();
  }

  onUnmounted(() => {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener?.('devicechange', refreshVideoDevices);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', unlockBlockedAudioPlayback);
      window.removeEventListener('keydown', unlockBlockedAudioPlayback);
    }
    if (vadInterval) clearInterval(vadInterval);
    if (troubleInterval !== null) clearInterval(troubleInterval);
    if (audioCtx) audioCtx.close();
    if (localAudioStream.value) {
      localAudioStream.value.getTracks().forEach((track) => track.stop());
    }
    if (localVideoStream.value) {
      localVideoStream.value.getTracks().forEach((track) => track.stop());
    }
    if (localScreenStream.value) {
      localScreenStream.value.getTracks().forEach((track) => track.stop());
    }
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    screenPeerConnections.forEach((pc) => pc.close());
    screenPeerConnections.clear();
    remoteAudioElements.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
    });
    remoteAudioElements.clear();
  });

  return {
    initLocalAudio,
    toggleCamera,
    switchCamera,
    toggleScreenShare,
    refreshVideoDevices,
    handleSignal,
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
    // Read-only escape hatch for integration tests to inspect actual RTCPeerConnection state
    // (signaling state, senders/tracks) instead of re-deriving it from reactive refs alone.
    // Not used by any UI component.
    __debugPeerConnections: peerConnections,
    __debugScreenPeerConnections: screenPeerConnections,
  };
}
