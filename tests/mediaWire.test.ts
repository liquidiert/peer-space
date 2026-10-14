import { describe, expect, it } from 'vitest';
import {
  announceMessage,
  decodePacket,
  encodeAudio,
  encodeControl,
  encodeVideo,
  mulawDecode,
  mulawEncode,
  resample,
  seq16After,
  validAnnounce,
} from '../src/lib/media/wire';
import { fitDimensions } from '../src/lib/media/video';

describe('media wire format', () => {
  it('round-trips audio packets, including the 16-bit sequence', () => {
    const p = decodePacket(encodeAudio('opus', 0xfffe, Uint8Array.of(7, 8, 9)));
    expect(p).toEqual({ kind: 'audio', codec: 'opus', seq: 0xfffe, payload: Uint8Array.of(7, 8, 9) });
  });

  it('round-trips keyframes with their decoder config, and deltas without', () => {
    const key = decodePacket(
      encodeVideo({
        track: 'screen',
        key: true,
        seq: 41,
        timestamp: 2 ** 32 - 1,
        config: { codec: 'avc1.42E028', width: 1920, height: 1080 },
        payload: Uint8Array.of(1, 2),
      })
    );
    expect(key).toEqual({
      kind: 'video',
      track: 'screen',
      key: true,
      seq: 41,
      timestamp: 2 ** 32 - 1,
      config: { codec: 'avc1.42E028', width: 1920, height: 1080 },
      payload: Uint8Array.of(1, 2),
    });

    const delta = decodePacket(encodeVideo({ track: 'camera', key: false, seq: 42, timestamp: 5, payload: Uint8Array.of(3) }));
    expect(delta).toMatchObject({ kind: 'video', track: 'camera', key: false, seq: 42, config: undefined });
  });

  it('round-trips control messages', () => {
    expect(decodePacket(encodeControl('keyframe', 'camera'))).toEqual({ kind: 'control', op: 'keyframe', track: 'camera' });
    expect(decodePacket(encodeControl('stopped', 'screen'))).toEqual({ kind: 'control', op: 'stopped', track: 'screen' });
  });

  it('rejects malformed and unknown packets instead of throwing', () => {
    expect(decodePacket(new Uint8Array())).toBeNull();
    expect(decodePacket(Uint8Array.of(9, 0, 0, 0))).toBeNull();
    expect(decodePacket(Uint8Array.of(1, 7, 0, 0))).toBeNull();
    expect(decodePacket(Uint8Array.of(3, 1, 5))).toBeNull();
    // Keyframe claiming a 200-byte codec string in a short packet.
    expect(decodePacket(Uint8Array.of(2, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 200, 1))).toBeNull();
  });

  it('orders wrapping sequence numbers', () => {
    expect(seq16After(1, 0)).toBe(true);
    expect(seq16After(0, 0xffff)).toBe(true);
    expect(seq16After(0xffff, 0)).toBe(false);
    expect(seq16After(5, 5)).toBe(false);
  });

  it('mu-law keeps speech-level signals close to the original', () => {
    const input = Float32Array.from({ length: 320 }, (_, i) => 0.5 * Math.sin(i / 5));
    const output = mulawDecode(mulawEncode(input));
    const maxErr = Math.max(...input.map((v, i) => Math.abs(v - output[i])));
    expect(maxErr).toBeLessThan(0.02);
  });

  it('resamples 20 ms frames between rates', () => {
    expect(resample(new Float32Array(960), 48000, 16000)).toHaveLength(320);
    expect(resample(new Float32Array(320), 16000, 44100)).toHaveLength(882);
  });

  it('fits video into the profile box as even dimensions', () => {
    expect(fitDimensions(1280, 720, 640, 480)).toEqual({ width: 640, height: 360 });
    expect(fitDimensions(2560, 1600, 1920, 1080)).toEqual({ width: 1728, height: 1080 });
    expect(fitDimensions(321, 241, 640, 480)).toEqual({ width: 322, height: 242 });
  });

  it('validates announces structurally', () => {
    const ok = { endpointId: 'a'.repeat(64), relay: 'https://relay.example/', sig: 'b'.repeat(128) };
    expect(validAnnounce(ok)).toBe(true);
    expect(validAnnounce({ ...ok, relay: undefined })).toBe(true);
    expect(validAnnounce({ ...ok, endpointId: 'A'.repeat(64) })).toBe(false);
    expect(validAnnounce({ ...ok, sig: 'b'.repeat(127) })).toBe(false);
    expect(validAnnounce({ ...ok, relay: 'javascript:alert(1)' })).toBe(false);
    expect(validAnnounce(null)).toBe(false);
  });

  it('binds the announce signature to the socket', () => {
    const msg = (s: string) => new TextDecoder().decode(announceMessage(s, 'e'.repeat(64), 'https://r/'));
    expect(msg('one')).not.toEqual(msg('two'));
  });
});
