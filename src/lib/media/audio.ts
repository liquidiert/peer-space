/**
 * Voice over iroh datagrams: 20 ms frames captured by an AudioWorklet, encoded once with
 * WebCodecs Opus (mu-law at 16 kHz where the browser has no Opus encoder) and fanned out
 * to every peer in earshot. Each remote peer gets a small jitter buffer and a GainNode, so
 * proximity volume and per-user trims are plain gain changes.
 */
import { AUDIO_FRAME_MS, MULAW_RATE, mulawDecode, mulawEncode, resample, seq16After, type AudioPacket, type AudioCodec } from './wire';

/** Opus voice at 32 kb/s is clear speech; DTX sends almost nothing during silence. */
const OPUS_BITRATE = 32_000;

const CAPTURE_WORKLET = `
class PsCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = new Float32Array(options.processorOptions.frameSize);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, this.frame.length - this.filled);
      this.frame.set(input.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('ps-capture', PsCapture);

// Jitter buffer: waits for a little audio before starting, plays out at the device rate,
// and if the network delivers a burst, drops the oldest audio to keep the delay bounded.
class PsPlayout extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = sampleRate;
    this.buf = new Float32Array(Math.ceil(rate * 1.0));
    this.read = 0;
    this.size = 0;
    this.startAt = Math.round(rate * options.processorOptions.prebufferMs / 1000);
    this.maxDelay = Math.round(rate * options.processorOptions.maxDelayMs / 1000);
    this.playing = false;
    this.port.onmessage = (e) => this.push(e.data);
  }
  push(chunk) {
    const cap = this.buf.length;
    for (let i = 0; i < chunk.length; i++) {
      if (this.size === cap) { this.read = (this.read + 1) % cap; this.size--; }
      this.buf[(this.read + this.size) % cap] = chunk[i];
      this.size++;
    }
    if (this.size > this.maxDelay) {
      const drop = this.size - this.startAt;
      this.read = (this.read + drop) % cap;
      this.size -= drop;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.size >= this.startAt) this.playing = true;
    if (!this.playing) return true;
    const cap = this.buf.length;
    const n = Math.min(out.length, this.size);
    for (let i = 0; i < n; i++) out[i] = this.buf[(this.read + i) % cap];
    this.read = (this.read + n) % cap;
    this.size -= n;
    if (n < out.length) this.playing = false; // underrun: rebuffer
    return true;
  }
}
registerProcessor('ps-playout', PsPlayout);
`;

const hasWebCodecsAudio = () =>
  typeof (globalThis as any).AudioEncoder === 'function' && typeof (globalThis as any).AudioDecoder === 'function';

/** One shared AudioContext and the worklet module, created on first use. */
export class AudioEngine {
  readonly ctx: AudioContext;
  private ready: Promise<void>;

  constructor() {
    const Ctor: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    // 48 kHz is Opus' native rate; browsers resample to the device for us.
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      ctx = new Ctor({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    this.ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }

  get suspended() {
    return this.ctx.state === 'suspended';
  }

  resume(): Promise<void> {
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  async whenReady() {
    await this.ready;
  }

  close() {
    this.ctx.close().catch(() => {});
  }
}

/**
 * Encodes the local microphone once, emitting finished packets payloads to `onPacket`.
 * Muting stops encoding entirely, so a muted mic costs no bandwidth.
 */
export class AudioSender {
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private encoder: AudioEncoder | null = null;
  private codec: AudioCodec = 'mulaw';
  private seq = 0;
  private frameIndex = 0;
  enabled = true;

  constructor(
    private engine: AudioEngine,
    private onPacket: (codec: AudioCodec, seq: number, payload: Uint8Array) => void
  ) {}

  async start(stream: MediaStream) {
    await this.engine.whenReady();
    const { ctx } = this.engine;
    const rate = ctx.sampleRate;
    const frameSize = Math.round((rate * AUDIO_FRAME_MS) / 1000);

    if (hasWebCodecsAudio()) {
      const config: AudioEncoderConfig = {
        codec: 'opus',
        sampleRate: rate,
        numberOfChannels: 1,
        bitrate: OPUS_BITRATE,
        opus: { frameDuration: AUDIO_FRAME_MS * 1000, usedtx: true, complexity: 5 },
      } as AudioEncoderConfig;
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
      if (support?.supported) {
        this.encoder = new AudioEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            this.onPacket('opus', this.nextSeq(), data);
          },
          error: (e) => console.warn('Opus encoder error:', e),
        });
        this.encoder.configure(config);
        this.codec = 'opus';
      }
    }

    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, 'ps-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { frameSize },
    });
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(e.data, rate);
    this.source.connect(this.node);
  }

  private nextSeq() {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    return s;
  }

  private onFrame(samples: Float32Array, rate: number) {
    if (!this.enabled) return;
    if (this.codec === 'opus' && this.encoder?.state === 'configured') {
      // A backed-up encoder means the device can't keep up; skipping is better than lagging.
      if (this.encoder.encodeQueueSize > 4) return;
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: samples.length,
        numberOfChannels: 1,
        timestamp: (this.frameIndex++ * AUDIO_FRAME_MS * 1000) | 0,
        data: samples,
      });
      this.encoder.encode(data);
      data.close();
    } else {
      this.onPacket('mulaw', this.nextSeq(), mulawEncode(resample(samples, rate, MULAW_RATE)));
    }
  }

  replaceStream(stream: MediaStream) {
    if (!this.node) return;
    this.source?.disconnect();
    this.source = this.engine.ctx.createMediaStreamSource(stream);
    this.source.connect(this.node);
  }

  stop() {
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.node = null;
    this.source = null;
    this.encoder = null;
  }
}

/** Playback of one remote peer's voice. */
export class RemoteAudio {
  /** Connect extra local sources (e.g. a test tone) here to share the volume control. */
  readonly input: GainNode;
  private playout: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private lastSeq: number | null = null;
  private closed = false;

  constructor(private engine: AudioEngine) {
    this.input = engine.ctx.createGain();
    this.input.gain.value = 0;
    this.input.connect(engine.ctx.destination);
  }

  set volume(v: number) {
    this.input.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.05);
  }

  get volume() {
    return this.input.gain.value;
  }

  private async ensurePlayout() {
    if (this.playout || this.closed) return;
    await this.engine.whenReady();
    if (this.playout || this.closed) return;
    this.playout = new AudioWorkletNode(this.engine.ctx, 'ps-playout', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { prebufferMs: 60, maxDelayMs: 240 },
    });
    this.playout.connect(this.input);
  }

  private ensureDecoder() {
    if (this.decoder || !hasWebCodecsAudio()) return this.decoder;
    this.decoder = new AudioDecoder({
      output: (data) => {
        const pcm = new Float32Array(data.numberOfFrames);
        data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
        this.pushPcm(resample(pcm, data.sampleRate, this.engine.ctx.sampleRate));
        data.close();
      },
      error: (e) => {
        console.warn('Opus decoder error:', e);
        this.decoder = null;
      },
    });
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    return this.decoder;
  }

  private pushPcm(pcm: Float32Array) {
    this.playout?.port.postMessage(pcm, [pcm.buffer]);
  }

  /** Feed one received packet. Late (reordered) packets are dropped: their slot already played. */
  push(packet: AudioPacket) {
    if (this.closed) return;
    if (this.lastSeq !== null && !seq16After(packet.seq, this.lastSeq)) return;
    this.lastSeq = packet.seq;
    void this.ensurePlayout().then(() => {
      if (this.closed) return;
      if (packet.codec === 'opus') {
        const decoder = this.ensureDecoder();
        if (!decoder || decoder.state !== 'configured') return;
        decoder.decode(
          new EncodedAudioChunk({ type: 'key', timestamp: packet.seq * AUDIO_FRAME_MS * 1000, data: packet.payload })
        );
      } else {
        this.pushPcm(resample(mulawDecode(packet.payload), MULAW_RATE, this.engine.ctx.sampleRate));
      }
    });
  }

  close() {
    this.closed = true;
    this.playout?.disconnect();
    this.input.disconnect();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.playout = null;
    this.decoder = null;
  }
}
