/**
 * Fakes for the browser media APIs and the media pipeline (codecs, audio graph), so the
 * proximity media logic can be exercised in happy-dom. Encoders and decoders are replaced
 * by objects that record what they were asked to send and receive.
 */
import type { MediaDeps } from '../../src/composables/useProximityMedia';
import { encodeVideo, type AudioCodec, type AudioPacket, type VideoPacket, type VideoTrackKind } from '../../src/lib/media/wire';
import type { TrackOut } from '../../src/lib/media/transport';

export class FakeMediaStreamTrack {
  kind: 'audio' | 'video';
  id = `track_${Math.random().toString(36).slice(2, 8)}`;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  contentHint = '';
  private listeners = new Map<string, Set<() => void>>();

  constructor(kind: 'audio' | 'video', private settings: Record<string, unknown> = {}) {
    this.kind = kind;
  }
  getSettings() {
    return this.settings;
  }
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
  /** Simulate the browser's own "Stop sharing" control. */
  endTrack() {
    this.readyState = 'ended';
    [...(this.listeners.get('ended') ?? [])].forEach((fn) => fn());
  }
}

export class FakeMediaStream {
  id = `stream_${Math.random().toString(36).slice(2, 8)}`;
  constructor(private tracks: FakeMediaStreamTrack[] = []) {}
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

/** Enough of AudioContext for voice activity detection to run. */
class FakeAudioContext {
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

export function installMediaMocks() {
  const g = globalThis as any;
  g.MediaStream = FakeMediaStream;
  g.AudioContext = FakeAudioContext;
  g.navigator = {
    ...(g.navigator ?? {}),
    mediaDevices: {
      getUserMedia: (c: any) =>
        Promise.resolve(
          new FakeMediaStream([
            ...(c?.audio ? [new FakeMediaStreamTrack('audio')] : []),
            ...(c?.video ? [new FakeMediaStreamTrack('video', { deviceId: c.video.deviceId?.exact ?? 'default-cam' })] : []),
          ])
        ),
      getDisplayMedia: () => Promise.resolve(new FakeMediaStream([new FakeMediaStreamTrack('video')])),
      enumerateDevices: () => Promise.resolve([]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
}

export class FakeAudioSender {
  enabled = true;
  started = false;
  private seq = 0;
  constructor(private onPacket: (codec: AudioCodec, seq: number, payload: Uint8Array) => void) {}
  async start() {
    this.started = true;
  }
  replaceStream() {}
  stop() {
    this.started = false;
  }
  /** One captured 20 ms frame: sent only while unmuted, like the real sender. */
  frame() {
    if (this.started && this.enabled) this.onPacket('opus', this.seq++, Uint8Array.of(1, 2, 3));
  }
}

export class FakeRemoteAudio {
  volume = 0;
  packets: AudioPacket[] = [];
  closed = false;
  push(p: AudioPacket) {
    this.packets.push(p);
  }
  close() {
    this.closed = true;
  }
}

export class FakeVideoSender {
  subs = new Map<string, { out: TrackOut; needsKey: boolean }>();
  keyframeRequests: Array<string | undefined> = [];
  stopped = false;
  private seq = 0;
  constructor(readonly kind: VideoTrackKind, public track: MediaStreamTrack) {}
  get subscriberIds() {
    return [...this.subs.keys()];
  }
  start() {}
  has(id: string) {
    return this.subs.has(id);
  }
  subscribe(id: string, out: TrackOut) {
    this.subs.set(id, { out, needsKey: true });
  }
  unsubscribe(id: string) {
    this.subs.get(id)?.out.close();
    this.subs.delete(id);
  }
  requestKeyframe(id?: string) {
    this.keyframeRequests.push(id);
  }
  replaceTrack(track: MediaStreamTrack) {
    this.track = track;
  }
  stop() {
    this.stopped = true;
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
  }
  /** Encode one frame and fan it out. */
  frame(key = true) {
    const packet = encodeVideo({
      track: this.kind,
      key,
      seq: this.seq++,
      timestamp: 0,
      config: key ? { codec: 'vp8', width: 640, height: 480 } : undefined,
      payload: Uint8Array.of(9),
    });
    for (const sub of this.subs.values()) {
      if (sub.needsKey && !key) continue;
      sub.needsKey = !sub.out.send(packet);
    }
  }
}

export class FakeVideoReceiver {
  stream = new FakeMediaStream() as unknown as MediaStream;
  packets: VideoPacket[] = [];
  closed = false;
  constructor(readonly askForKey: () => void, private onFirstFrame: () => void) {}
  push(p: VideoPacket) {
    this.packets.push(p);
    if (this.packets.length === 1) this.onFirstFrame();
  }
  close() {
    this.closed = true;
  }
}

/** Media deps plus handles to everything they created, for assertions. */
export function fakeMediaDeps(createTransport: MediaDeps['createTransport']) {
  const created = {
    audioSenders: [] as FakeAudioSender[],
    remoteAudio: [] as FakeRemoteAudio[],
    videoSenders: [] as FakeVideoSender[],
    receivers: [] as FakeVideoReceiver[],
    engine: { suspended: false, resumed: 0 },
  };
  const deps: MediaDeps = {
    createTransport,
    createAudioEngine: () => ({
      get suspended() {
        return created.engine.suspended;
      },
      resume: async () => {
        created.engine.resumed++;
        created.engine.suspended = false;
      },
      close: () => {},
    }),
    createAudioSender: (_engine, onPacket) => {
      const s = new FakeAudioSender(onPacket);
      created.audioSenders.push(s);
      return s;
    },
    createRemoteAudio: () => {
      const r = new FakeRemoteAudio();
      created.remoteAudio.push(r);
      return r;
    },
    createVideoSender: (kind, track) => {
      const s = new FakeVideoSender(kind, track);
      created.videoSenders.push(s);
      return s;
    },
    createVideoReceiver: (onKey, onFirst) => {
      const r = new FakeVideoReceiver(onKey, onFirst);
      created.receivers.push(r);
      return r;
    },
  };
  return { deps, created };
}
