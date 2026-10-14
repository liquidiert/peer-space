/**
 * Video over iroh streams. Each local track (camera, screen) is encoded once with WebCodecs
 * and fanned out to every subscribed peer, instead of one encoder per peer as with WebRTC.
 * A peer whose stream can't keep up has frames dropped, then resumes at the next keyframe,
 * so a slow link never builds up delay or slows down anyone else.
 */
import { encodeVideo, type VideoPacket, type VideoTrackKind } from './wire';
import type { TrackOut } from './transport';

export interface VideoProfile {
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrate: number;
  /** Regular keyframes bound how long a receiver that lost sync waits. */
  keyframeIntervalMs: number;
}

export const CAMERA_PROFILE: VideoProfile = {
  maxWidth: 640,
  maxHeight: 480,
  fps: 15,
  bitrate: 450_000,
  keyframeIntervalMs: 10_000,
};

/** Screens favour sharpness over motion: text must stay readable. */
export const SCREEN_PROFILE: VideoProfile = {
  maxWidth: 1920,
  maxHeight: 1080,
  fps: 8,
  bitrate: 1_200_000,
  keyframeIntervalMs: 10_000,
};

/** Fit (w, h) into the profile's box, keeping aspect ratio, as even numbers (codecs need them). */
export function fitDimensions(w: number, h: number, maxW: number, maxH: number) {
  const scale = Math.min(1, maxW / w, maxH / h);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** Codecs to try, best first. H.264 baseline decodes everywhere WebCodecs exists. */
function codecCandidates(width: number, height: number): string[] {
  // Level 3.1 covers 720p; anything bigger (screen share) needs level 4.0.
  const avc = width * height > 1280 * 720 ? 'avc1.42E028' : 'avc1.42E01F';
  return [avc, 'vp8', 'vp09.00.10.08'];
}

async function pickConfig(width: number, height: number, profile: VideoProfile, hint: 'motion' | 'detail') {
  for (const codec of codecCandidates(width, height)) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: profile.bitrate,
      framerate: profile.fps,
      latencyMode: 'realtime',
      contentHint: hint,
      ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}),
    } as VideoEncoderConfig;
    const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
    if (support?.supported) return config;
  }
  return null;
}

export const hasWebCodecsVideo = () =>
  typeof (globalThis as any).VideoEncoder === 'function' && typeof (globalThis as any).VideoDecoder === 'function';

interface Subscriber {
  out: TrackOut;
  /** Waiting for a keyframe: just subscribed, or a frame to it was dropped. */
  needsKey: boolean;
}

/** Encodes one local video track and fans the frames out to subscribers. */
export class VideoSender {
  private subscribers = new Map<string, Subscriber>();
  private encoder: VideoEncoder | null = null;
  private config: VideoEncoderConfig | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private lastKeyAt = 0;
  private keyRequested = true;
  private configuring = false;
  private stopped = false;

  constructor(
    readonly kind: VideoTrackKind,
    private track: MediaStreamTrack,
    private profile: VideoProfile
  ) {}

  start() {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([this.track]);
    video.play().catch(() => {});
    this.video = video;
    this.timer = setInterval(() => this.capture(), 1000 / this.profile.fps);
  }

  /** Swap the source track (camera switch) without touching subscribers. */
  replaceTrack(track: MediaStreamTrack) {
    this.track = track;
    if (this.video) this.video.srcObject = new MediaStream([track]);
    this.keyRequested = true;
  }

  get subscriberIds() {
    return [...this.subscribers.keys()];
  }

  has(peerId: string) {
    return this.subscribers.has(peerId);
  }

  subscribe(peerId: string, out: TrackOut) {
    this.subscribers.get(peerId)?.out.close();
    this.subscribers.set(peerId, { out, needsKey: true });
    this.keyRequested = true;
  }

  unsubscribe(peerId: string) {
    const sub = this.subscribers.get(peerId);
    if (!sub) return;
    sub.out.close();
    this.subscribers.delete(peerId);
  }

  /** A receiver lost sync (or its decoder failed) and asks for a fresh keyframe. */
  requestKeyframe(peerId?: string) {
    const sub = peerId ? this.subscribers.get(peerId) : undefined;
    if (sub) sub.needsKey = true;
    this.keyRequested = true;
  }

  private async ensureEncoder(width: number, height: number) {
    if (this.configuring) return false;
    if (this.encoder && this.config?.width === width && this.config?.height === height) return true;
    this.configuring = true;
    try {
      const config = await pickConfig(width, height, this.profile, this.kind === 'screen' ? 'detail' : 'motion');
      if (!config || this.stopped) return false;
      if (!this.encoder || this.encoder.state === 'closed') {
        this.encoder = new VideoEncoder({
          output: (chunk) => this.onChunk(chunk),
          error: (e) => {
            console.warn(`${this.kind} encoder error:`, e);
            this.encoder = null;
            this.config = null;
          },
        });
      }
      this.encoder.configure(config);
      this.config = config;
      this.keyRequested = true;
      if (this.canvas) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      return true;
    } finally {
      this.configuring = false;
    }
  }

  private async capture() {
    const video = this.video;
    if (this.stopped || !video || this.subscribers.size === 0) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    const { width, height } = fitDimensions(video.videoWidth, video.videoHeight, this.profile.maxWidth, this.profile.maxHeight);
    if (!(await this.ensureEncoder(width, height)) || !this.encoder) return;
    // Encoder falling behind (slow device): skip this frame rather than queue it.
    if (this.encoder.encodeQueueSize > 2) return;

    if (!this.canvas) {
      this.canvas =
        typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);

    const now = performance.now();
    const key = this.keyRequested || now - this.lastKeyAt >= this.profile.keyframeIntervalMs;
    if (key) {
      this.keyRequested = false;
      this.lastKeyAt = now;
    }
    const frame = new VideoFrame(this.canvas as CanvasImageSource, { timestamp: Math.round(now * 1000) });
    this.encoder.encode(frame, { keyFrame: key });
    frame.close();
  }

  private onChunk(chunk: EncodedVideoChunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    const config = this.config!;
    const packet = encodeVideo({
      track: this.kind,
      key,
      seq: this.seq++,
      timestamp: chunk.timestamp,
      config: key ? { codec: config.codec, width: config.width, height: config.height } : undefined,
      payload: data,
    });
    for (const sub of this.subscribers.values()) {
      if (sub.needsKey && !key) continue;
      if (sub.out.send(packet)) {
        sub.needsKey = false;
      } else {
        // That link is congested: stop sending deltas it can't decode anyway, and get a
        // keyframe going so it can rejoin as soon as it has room.
        sub.needsKey = true;
        this.keyRequested = true;
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.subscribers.keys()]) this.unsubscribe(id);
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = null;
  }
}

/**
 * Decodes one remote track into a canvas, exposed as a MediaStream so the video dock can
 * treat it like any other stream.
 */
export class VideoReceiver {
  readonly stream: MediaStream;
  private canvas: HTMLCanvasElement;
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private lastSeq: number | null = null;
  private waitingForKey = true;
  private lastKeyRequest = 0;
  private hasFrame = false;

  constructor(
    private onKeyframeNeeded: () => void,
    /** First decoded frame: the tile can be shown. */
    private onFirstFrame: () => void
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    this.stream = (this.canvas as any).captureStream ? this.canvas.captureStream() : new MediaStream();
  }

  private askForKey() {
    this.waitingForKey = true;
    const now = performance.now();
    if (now - this.lastKeyRequest < 500) return;
    this.lastKeyRequest = now;
    this.onKeyframeNeeded();
  }

  private configure(codec: string) {
    if (this.decoder && this.decoder.state !== 'closed' && this.codec === codec) return true;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: (e) => {
        console.warn('video decoder error:', e);
        this.decoder = null;
        this.codec = null;
        this.askForKey();
      },
    });
    try {
      this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' } as VideoDecoderConfig);
      this.codec = codec;
      return true;
    } catch (err) {
      console.warn(`can't decode ${codec}:`, err);
      this.decoder = null;
      return false;
    }
  }

  private draw(frame: VideoFrame) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.getContext('2d')?.drawImage(frame, 0, 0, w, h);
    frame.close();
    if (!this.hasFrame) {
      this.hasFrame = true;
      this.onFirstFrame();
    }
  }

  push(packet: VideoPacket) {
    const inOrder = this.lastSeq !== null && packet.seq === ((this.lastSeq + 1) >>> 0);
    this.lastSeq = packet.seq;
    if (packet.key && packet.config) {
      if (!this.configure(packet.config.codec)) return;
      this.waitingForKey = false;
    } else if (this.waitingForKey || !inOrder) {
      // A gap means the sender dropped frames for us; deltas won't decode until a keyframe.
      this.askForKey();
      return;
    }
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return this.askForKey();
    if (decoder.decodeQueueSize > 4 && !packet.key) return this.askForKey();
    try {
      decoder.decode(
        new EncodedVideoChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data: packet.payload })
      );
    } catch (err) {
      console.warn('video decode failed:', err);
      this.askForKey();
    }
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.stream.getTracks().forEach((t) => t.stop());
  }
}
