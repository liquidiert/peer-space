/**
 * Byte formats for proximity media sent over iroh (see crates/peer-media).
 *
 * Audio goes out as QUIC datagrams, one 20 ms frame each, so a lost or late packet never
 * holds up the ones behind it. Video and control messages go over ordered streams (one per
 * track), framed by the transport. Everything here is pure so it can be unit tested.
 */

export const PACKET_AUDIO = 1;
export const PACKET_VIDEO = 2;
export const PACKET_CONTROL = 3;

export type AudioCodec = 'opus' | 'mulaw';
const AUDIO_CODEC_IDS: Record<AudioCodec, number> = { opus: 1, mulaw: 2 };

/** Camera and screen share are separate tracks, each with its own stream and decoder. */
export type VideoTrackKind = 'camera' | 'screen';
const TRACK_IDS: Record<VideoTrackKind, number> = { camera: 0, screen: 1 };
const trackFromId = (id: number): VideoTrackKind | null =>
  id === 0 ? 'camera' : id === 1 ? 'screen' : null;

/** Control operations, sent on the reliable control stream. */
export type ControlOp = 'keyframe' | 'stopped';
const CONTROL_IDS: Record<ControlOp, number> = { keyframe: 1, stopped: 2 };

/** Sample rate of the 'mulaw' fallback codec (used where WebCodecs has no Opus encoder). */
export const MULAW_RATE = 16000;
/** Every audio packet carries 20 ms. */
export const AUDIO_FRAME_MS = 20;

export interface AudioPacket {
  kind: 'audio';
  codec: AudioCodec;
  seq: number;
  payload: Uint8Array;
}

export interface VideoPacket {
  kind: 'video';
  track: VideoTrackKind;
  key: boolean;
  seq: number;
  /** Capture time in microseconds (wraps at 2^32, only used for decoder ordering). */
  timestamp: number;
  /** Present on keyframes: everything a receiver needs to (re)configure its decoder. */
  config?: { codec: string; width: number; height: number };
  payload: Uint8Array;
}

export interface ControlPacket {
  kind: 'control';
  op: ControlOp;
  track: VideoTrackKind;
}

export type MediaPacket = AudioPacket | VideoPacket | ControlPacket;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeAudio(codec: AudioCodec, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = PACKET_AUDIO;
  out[1] = AUDIO_CODEC_IDS[codec];
  out[2] = (seq >>> 8) & 0xff;
  out[3] = seq & 0xff;
  out.set(payload, 4);
  return out;
}

export function encodeVideo(p: Omit<VideoPacket, 'kind'>): Uint8Array {
  const codec = p.key && p.config ? enc.encode(p.config.codec) : null;
  if (codec && codec.length > 255) throw new Error('codec string too long');
  const header = 12 + (codec ? 1 + codec.length + 4 : 0);
  const out = new Uint8Array(header + p.payload.length);
  const view = new DataView(out.buffer);
  out[0] = PACKET_VIDEO;
  out[1] = TRACK_IDS[p.track];
  out[2] = (p.key ? 1 : 0) | (codec ? 2 : 0);
  out[3] = 0;
  view.setUint32(4, p.seq >>> 0);
  view.setUint32(8, p.timestamp >>> 0);
  if (codec) {
    out[12] = codec.length;
    out.set(codec, 13);
    view.setUint16(13 + codec.length, p.config!.width);
    view.setUint16(15 + codec.length, p.config!.height);
  }
  out.set(p.payload, header);
  return out;
}

export function encodeControl(op: ControlOp, track: VideoTrackKind): Uint8Array {
  return Uint8Array.of(PACKET_CONTROL, CONTROL_IDS[op], TRACK_IDS[track]);
}

/** Parse any media packet. Returns null for anything malformed or unknown. */
export function decodePacket(bytes: Uint8Array): MediaPacket | null {
  if (bytes.length < 3) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (bytes[0]) {
    case PACKET_AUDIO: {
      if (bytes.length < 4) return null;
      const codec = bytes[1] === 1 ? 'opus' : bytes[1] === 2 ? 'mulaw' : null;
      if (!codec) return null;
      return { kind: 'audio', codec, seq: (bytes[2] << 8) | bytes[3], payload: bytes.subarray(4) };
    }
    case PACKET_VIDEO: {
      if (bytes.length < 12) return null;
      const track = trackFromId(bytes[1]);
      if (!track) return null;
      const key = (bytes[2] & 1) === 1;
      const hasConfig = (bytes[2] & 2) === 2;
      let offset = 12;
      let config: VideoPacket['config'];
      if (hasConfig) {
        const n = bytes[12];
        if (bytes.length < 13 + n + 4) return null;
        config = {
          codec: dec.decode(bytes.subarray(13, 13 + n)),
          width: view.getUint16(13 + n),
          height: view.getUint16(15 + n),
        };
        offset = 17 + n;
      }
      return {
        kind: 'video',
        track,
        key,
        seq: view.getUint32(4),
        timestamp: view.getUint32(8),
        config,
        payload: bytes.subarray(offset),
      };
    }
    case PACKET_CONTROL: {
      const op = bytes[1] === 1 ? 'keyframe' : bytes[1] === 2 ? 'stopped' : null;
      const track = trackFromId(bytes[2]);
      return op && track ? { kind: 'control', op, track } : null;
    }
  }
  return null;
}

/** True when `seq` (16-bit, wrapping) comes after `prev`. */
export function seq16After(seq: number, prev: number): boolean {
  const d = (seq - prev) & 0xffff;
  return d !== 0 && d < 0x8000;
}

// --- G.711 mu-law, the fallback when the browser has no Opus encoder ---------------------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function mulawEncode(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > MULAW_CLIP) s = MULAW_CLIP;
    s += MULAW_BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function mulawDecode(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const s = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
    out[i] = (sign ? -s : s) / 32768;
  }
  return out;
}

/** Linear-interpolation resampler; plenty for speech on the fallback path. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

// --- Announcing a media endpoint over the signalling socket -----------------------------

/** What a client publishes so others can dial it: its iroh endpoint id and home relay. */
export interface MediaAnnounce {
  endpointId: string;
  relay?: string;
  /** Hex ed25519 signature over {@link announceMessage}, made with the endpoint's key. */
  sig: string;
}

/**
 * The signature binds an endpoint id to one socket, so nobody can claim someone else's
 * endpoint (which would attribute that person's audio and video to the wrong avatar).
 */
export const announceMessage = (socketId: string, endpointId: string, relay: string) =>
  enc.encode(`peerspace-media|${socketId}|${endpointId}|${relay}`);

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

export const ENDPOINT_ID_RE = /^[0-9a-f]{64}$/;
export const SIGNATURE_RE = /^[0-9a-f]{128}$/;

/** Structural check of an announce received from the network (signature checked separately). */
export function validAnnounce(a: unknown): a is MediaAnnounce {
  const x = a as MediaAnnounce;
  return (
    !!x &&
    typeof x.endpointId === 'string' &&
    ENDPOINT_ID_RE.test(x.endpointId) &&
    typeof x.sig === 'string' &&
    SIGNATURE_RE.test(x.sig) &&
    (x.relay === undefined ||
      (typeof x.relay === 'string' && x.relay.length <= 300 && /^https?:\/\//.test(x.relay)))
  );
}
