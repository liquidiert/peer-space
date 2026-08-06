/**
 * Minimal but behaviourally-faithful fakes for the browser WebRTC/media APIs.
 *
 * The goal is to model the parts the app actually depends on closely enough that real
 * bugs surface - in particular the RTCPeerConnection signaling state machine, which is
 * what makes offer/answer glare throw instead of silently "working".
 */

export class FakeMediaStreamTrack {
  kind: 'audio' | 'video';
  id: string;
  enabled = true;
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  private settings: Record<string, unknown>;
  private listeners = new Map<string, Set<() => void>>();

  constructor(kind: 'audio' | 'video', settings: Record<string, unknown> = {}) {
    this.kind = kind;
    this.id = `${kind}_${Math.random().toString(36).slice(2, 8)}`;
    this.settings = settings;
  }

  getSettings() {
    return this.settings;
  }

  // Screen share listens for the browser's native "Stop sharing" via addEventListener('ended')
  // rather than the onended property, so the fake has to support both.
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }

  stop() {
    this.readyState = 'ended';
  }

  /** Simulate the track ending on its own (user hit the browser's stop-sharing control). */
  endTrack() {
    this.readyState = 'ended';
    this.onended?.();
    [...(this.listeners.get('ended') ?? [])].forEach((fn) => fn());
  }
}

export class FakeMediaStream {
  id = `stream_${Math.random().toString(36).slice(2, 8)}`;
  private tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

export class FakeRTCSessionDescription {
  type: string;
  sdp: string;
  constructor(init: { type: string; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

export class FakeRTCIceCandidate {
  candidate: string;
  constructor(init: { candidate: string }) {
    this.candidate = init.candidate;
  }
}

class FakeRTCRtpSender {
  track: FakeMediaStreamTrack | null;
  constructor(track: FakeMediaStreamTrack | null) {
    this.track = track;
  }
  replaceTrack(next: FakeMediaStreamTrack | null) {
    this.track = next;
    return Promise.resolve();
  }
}

export type SignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer' | 'closed';
export type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

/** Every peer connection constructed during a test, for assertions/inspection. */
export const allPeerConnections: FakeRTCPeerConnection[] = [];

export class FakeRTCPeerConnection {
  signalingState: SignalingState = 'stable';
  connectionState: ConnectionState = 'new';
  localDescription: FakeRTCSessionDescription | null = null;
  remoteDescription: FakeRTCSessionDescription | null = null;

  onicecandidate: ((e: any) => void) | null = null;
  ontrack: ((e: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  addedIceCandidates: FakeRTCIceCandidate[] = [];
  /** Counts how many offers this connection produced - used to detect renegotiation storms. */
  offersCreated = 0;

  private senders: FakeRTCRtpSender[] = [];
  private listeners = new Map<string, Set<() => void>>();

  /** The other side's FakeRTCPeerConnection, wired up by the test harness once it knows
   * which two connections belong to the same logical session (see SignalBus). */
  private linkedRemote: FakeRTCPeerConnection | null = null;

  constructor(_config?: unknown) {
    allPeerConnections.push(this);
  }

  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }

  private emit(type: string) {
    // Copy first: handlers commonly remove themselves during dispatch.
    [...(this.listeners.get(type) ?? [])].forEach((fn) => fn());
  }

  private setSignalingState(next: SignalingState) {
    this.signalingState = next;
    this.emit('signalingstatechange');
  }

  /** Wires this connection up to its counterpart so addTrack/removeTrack actually deliver
   * media across the fake "network", instead of tracks just sitting in `senders` unseen. */
  linkTo(remote: FakeRTCPeerConnection) {
    if (this.linkedRemote === remote) return;
    this.linkedRemote = remote;
    // Catch up on anything already added before the link existed (addTrack calls made
    // while creating the connection happen before any signaling round-trip completes).
    this.senders.forEach((s) => {
      if (s.track) remote.emitRemoteTrack(s.track);
    });
  }

  addTrack(track: FakeMediaStreamTrack, _stream?: FakeMediaStream) {
    const sender = new FakeRTCRtpSender(track);
    this.senders.push(sender);

    if (this.linkedRemote) {
      if (track.muted && track.onunmute) {
        // Re-adding a track that this same connection previously delivered and then
        // removed (proximity re-entry) reuses the existing transceiver in real WebRTC,
        // so the far side observes 'unmute', not a brand new 'ontrack'.
        track.muted = false;
        track.onunmute();
      } else {
        this.linkedRemote.emitRemoteTrack(track);
      }
    }
    return sender;
  }

  removeTrack(sender: FakeRTCRtpSender) {
    // Matches the browser: the sender stays attached to the connection, its track goes null.
    const track = sender.track;
    sender.track = null;
    if (track && this.linkedRemote && !track.muted) {
      track.muted = true;
      track.onmute?.();
    }
  }

  getSenders() {
    return [...this.senders];
  }

  async createOffer() {
    this.offersCreated++;
    return new FakeRTCSessionDescription({ type: 'offer', sdp: `offer_${this.offersCreated}` });
  }

  async createAnswer() {
    return new FakeRTCSessionDescription({ type: 'answer', sdp: 'answer' });
  }

  async setLocalDescription(desc: { type: string; sdp?: string }) {
    if (desc.type === 'rollback') {
      // Only valid while an offer is outstanding on either side; resets to stable so a
      // polite peer can accept a colliding remote offer instead of its own.
      if (this.signalingState === 'have-local-offer' || this.signalingState === 'have-remote-offer') {
        this.setSignalingState('stable');
        return;
      }
      throw new Error(`InvalidStateError: cannot rollback in state ${this.signalingState}`);
    }

    if (desc.type === 'offer') {
      if (this.signalingState !== 'stable') {
        throw new Error(
          `InvalidStateError: cannot setLocalDescription(offer) in state ${this.signalingState}`
        );
      }
      this.localDescription = desc as FakeRTCSessionDescription;
      this.setSignalingState('have-local-offer');
    } else {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(
          `InvalidStateError: cannot setLocalDescription(answer) in state ${this.signalingState}`
        );
      }
      this.localDescription = desc as FakeRTCSessionDescription;
      this.setSignalingState('stable');
    }
  }

  async setRemoteDescription(desc: FakeRTCSessionDescription) {
    if (desc.type === 'offer') {
      // This is the glare case: a remote offer arriving while our own offer is outstanding.
      // Real browsers reject this, which is exactly the failure we want tests to catch.
      if (this.signalingState !== 'stable') {
        throw new Error(
          `InvalidStateError: cannot setRemoteDescription(offer) in state ${this.signalingState}`
        );
      }
      this.remoteDescription = desc;
      this.setSignalingState('have-remote-offer');
    } else {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error(
          `InvalidStateError: cannot setRemoteDescription(answer) in state ${this.signalingState}`
        );
      }
      this.remoteDescription = desc;
      this.setSignalingState('stable');
    }
  }

  async addIceCandidate(candidate: FakeRTCIceCandidate) {
    if (!this.remoteDescription) {
      throw new Error('InvalidStateError: remote description not set');
    }
    this.addedIceCandidates.push(candidate);
  }

  close() {
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }

  // --- test-only helpers ---

  /** Simulate the ICE agent reporting a new connection state. */
  emitConnectionState(state: ConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** Simulate the remote end's media arriving on this connection. */
  emitRemoteTrack(track: FakeMediaStreamTrack, stream = new FakeMediaStream([track])) {
    this.ontrack?.({ track, streams: [stream] });
  }
}

/** Enough of AudioContext for setupVoiceActivityDetection() to run without throwing. */
export class FakeAudioContext {
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 128,
      getByteFrequencyData(arr: Uint8Array) {
        arr.fill(0);
      },
    };
  }
  close() {
    return Promise.resolve();
  }
}

/** Toggle to simulate a browser's autoplay policy rejecting audio.play(). */
export let autoplayBlocked = false;
export function setAutoplayBlocked(blocked: boolean) {
  autoplayBlocked = blocked;
}

export class FakeAudioElement {
  autoplay = false;
  volume = 1;
  srcObject: unknown = null;
  paused = true;
  setAttribute() {}
  play() {
    if (autoplayBlocked) {
      // Real browsers reject with a NotAllowedError DOMException; the message isn't
      // load-bearing for the app, only that the promise rejects.
      return Promise.reject(new Error('NotAllowedError'));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

export interface MediaHarnessOptions {
  /** Resolve getUserMedia manually, to model a slow permission prompt. */
  deferUserMedia?: boolean;
}

export function installWebRTCMocks(options: MediaHarnessOptions = {}) {
  allPeerConnections.length = 0;
  autoplayBlocked = false;

  const pendingUserMedia: Array<(stream: FakeMediaStream) => void> = [];

  const getUserMedia = (constraints: any) => {
    const tracks: FakeMediaStreamTrack[] = [];
    if (constraints?.audio) tracks.push(new FakeMediaStreamTrack('audio'));
    if (constraints?.video) {
      const deviceId =
        typeof constraints.video === 'object' && constraints.video.deviceId?.exact
          ? constraints.video.deviceId.exact
          : 'default-cam';
      tracks.push(new FakeMediaStreamTrack('video', { deviceId }));
    }
    const stream = new FakeMediaStream(tracks);

    if (options.deferUserMedia) {
      return new Promise<FakeMediaStream>((resolve) => {
        pendingUserMedia.push(() => resolve(stream));
      });
    }
    return Promise.resolve(stream);
  };

  const g = globalThis as any;

  g.RTCPeerConnection = FakeRTCPeerConnection;
  g.RTCSessionDescription = FakeRTCSessionDescription;
  g.RTCIceCandidate = FakeRTCIceCandidate;
  g.MediaStream = FakeMediaStream;
  g.Audio = FakeAudioElement;
  g.AudioContext = FakeAudioContext;
  g.navigator = {
    ...(g.navigator ?? {}),
    mediaDevices: {
      getUserMedia,
      getDisplayMedia: () => Promise.resolve(new FakeMediaStream([new FakeMediaStreamTrack('video')])),
      enumerateDevices: () =>
        Promise.resolve([
          { kind: 'videoinput', deviceId: 'default-cam', label: 'Front' },
          { kind: 'videoinput', deviceId: 'other-cam', label: 'Back' },
        ]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };

  return {
    /** Release a deferred getUserMedia call (see `deferUserMedia`). */
    flushUserMedia() {
      pendingUserMedia.splice(0).forEach((resolve) => resolve(new FakeMediaStream([])));
    },
    resolveUserMediaWith(stream: FakeMediaStream) {
      pendingUserMedia.splice(0).forEach((r) => r(stream));
    },
    get pendingUserMediaCount() {
      return pendingUserMedia.length;
    },
  };
}
