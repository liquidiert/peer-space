import { describe, expect, it } from 'vitest';
import { KeyframePolicy } from '../src/lib/media/video';

/** 15 fps: one frame every 66.7 ms, as VideoSender captures it. */
const FRAME_MS = 1000 / 15;
const at = (frame: number) => frame * FRAME_MS;

/** Runs one captured frame through the policy the way VideoSender does. */
function tick(policy: KeyframePolicy, frame: number): boolean {
  const now = at(frame);
  const key = policy.next(now);
  if (key) policy.keyEmitted(now);
  return key;
}

/** Runs frames [from, to) and returns the frame indices that became keyframes. */
function keyFrames(policy: KeyframePolicy, from: number, to: number): number[] {
  const keys: number[] = [];
  for (let f = from; f < to; f++) if (tick(policy, f)) keys.push(f);
  return keys;
}

describe('KeyframePolicy', () => {
  it('makes the first frame a keyframe, then waits for the periodic interval', () => {
    const policy = new KeyframePolicy(10_000);
    const keys = keyFrames(policy, 0, Math.ceil(25_000 / FRAME_MS));
    expect(keys.length).toBe(3);
    expect(keys[0]).toBe(0);
    // Periodic keyframes land on the first frame at or after each 10 s mark.
    expect(Math.abs(at(keys[1]) - 10_000)).toBeLessThanOrEqual(FRAME_MS);
    expect(Math.abs(at(keys[2]) - 20_000)).toBeLessThanOrEqual(FRAME_MS);
  });

  it('coalesces many requests inside one gap into a single keyframe', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    expect(tick(policy, 0)).toBe(true);
    for (let i = 0; i < 20; i++) policy.request(at(1));
    const keys = keyFrames(policy, 1, Math.ceil(3000 / FRAME_MS));
    expect(keys.length).toBe(1);
    expect(at(keys[0])).toBeGreaterThanOrEqual(1000);
    expect(at(keys[0])).toBeLessThanOrEqual(1000 + FRAME_MS);
  });

  it('does not lose a request made right after a keyframe: it fires at lastKeyAt + minGap', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    expect(tick(policy, 0)).toBe(true);
    policy.request(at(1));
    // Held back during the gap...
    expect(keyFrames(policy, 1, 15)).toEqual([]);
    // ...then fired at the first frame past it.
    const keys = keyFrames(policy, 15, 30);
    expect(keys).toEqual([15]);
  });

  it('fires an urgent request on the very next frame, even right after a keyframe', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    expect(tick(policy, 0)).toBe(true);
    policy.requestUrgent();
    expect(tick(policy, 1)).toBe(true);
    expect(tick(policy, 2)).toBe(false);
  });

  it('bounds keyframes for a subscriber that refuses every send (storm)', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    const frames = Math.ceil(5000 / FRAME_MS);
    let keys = 0;
    for (let f = 0; f < frames; f++) {
      const now = at(f);
      if (tick(policy, f)) keys++;
      // onChunk: every send to 'b' is refused.
      policy.congested('b', now);
    }
    // Backoff 1 s, 2 s, 4 s: keyframes at ~0 s, ~1 s and ~3 s. Without the backoff it was ~75.
    expect(keys).toBeGreaterThanOrEqual(1);
    expect(keys).toBeLessThanOrEqual(5);
  });

  it('holds a congestion trigger until its retry time, then honours it', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    expect(tick(policy, 0)).toBe(true);
    policy.congested('b', 0);
    expect(keyFrames(policy, 1, 15)).toEqual([]);
    expect(keyFrames(policy, 15, 16)).toEqual([15]);
  });

  it('resets a subscriber backoff after delivered()', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    expect(tick(policy, 0)).toBe(true);
    policy.congested('b', 0);
    expect(tick(policy, 15)).toBe(true);
    // Refused again: backoff has doubled to 2 s, retry at 3 s (frame 45).
    policy.congested('b', at(15));
    policy.delivered('b');
    // Refused once more after the reset: backoff is back to minGap, retry at ~2.07 s (frame 31).
    policy.congested('b', at(16));
    const keys = keyFrames(policy, 16, 50);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0]).toBeGreaterThanOrEqual(31);
    expect(keys[0]).toBeLessThanOrEqual(32);
  });

  it('ignores a forgotten subscriber\'s pending congestion', () => {
    const policy = new KeyframePolicy(10_000, 1000);
    expect(tick(policy, 0)).toBe(true);
    policy.congested('b', 0);
    policy.forget('b');
    expect(keyFrames(policy, 1, Math.ceil(4000 / FRAME_MS))).toEqual([]);
  });
});
