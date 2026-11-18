import { describe, expect, it } from 'vitest';
import {
  KART,
  directionFromHeading,
  isBoosting,
  isSliding,
  lerpAngle,
  normalizeAngle,
  slipAngle,
  speedOf,
  stepKart,
  tileOf,
  type KartInput,
  type KartState,
  type KartWorld,
} from '../src/lib/kart';

/** '#' solid, '.' road, ',' offroad; anything else (and out of bounds) is solid. */
function makeWorld(rows: string[]): KartWorld {
  return {
    surfaceAt(tx, ty) {
      const row = rows[ty];
      if (row === undefined || tx < 0 || tx >= row.length) return 'solid';
      const ch = row[tx];
      if (ch === '.') return 'road';
      if (ch === ',') return 'offroad';
      return 'solid';
    },
  };
}

/** A walled rectangle with the given interior character. */
function box(width: number, height: number, inner = '.'): string[] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : inner,
    ).join(''),
  );
}

const IDLE: KartInput = { throttle: 0, steer: 0, drift: false, boost: false };
const FLOOR_THROTTLE: KartInput = { throttle: 1, steer: 0, drift: false, boost: false };
const BOOST_THROTTLE: KartInput = { throttle: 1, steer: 0, drift: false, boost: true };

function at(x: number, y: number, extra: Partial<KartState> = {}): KartState {
  return { x, y, heading: 0, vx: 0, vy: 0, boost: 1, boosting: false, ...extra };
}

/** Steps frames of 1/hz seconds and returns the state after each frame. */
function run(
  s: KartState,
  input: KartInput,
  seconds: number,
  world: KartWorld,
  hz = 60,
): KartState[] {
  const frames: KartState[] = [];
  let cur = s;
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    cur = stepKart(cur, input, 1 / hz, world);
    frames.push(cur);
  }
  return frames;
}

function last<T>(xs: T[]): T {
  return xs[xs.length - 1];
}

describe('acceleration and top speed', () => {
  it('accelerates from rest to near max speed on road within ~2 s', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10), FLOOR_THROTTLE, 2, world);
    expect(speedOf(last(frames))).toBeGreaterThan(12.5);
    expect(speedOf(last(frames))).toBeLessThanOrEqual(KART.maxSpeed + 1e-9);
  });

  it('road top speed exceeds 10 tiles/s and is capped at maxSpeed', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10), FLOOR_THROTTLE, 4, world);
    const top = Math.max(...frames.map(speedOf));
    expect(top).toBeGreaterThan(10);
    expect(top).toBeLessThanOrEqual(KART.maxSpeed + 1e-9);
  });

  it('offroad top speed is below 7 tiles/s', () => {
    const world = makeWorld(box(80, 20, ','));
    const frames = run(at(5, 10), FLOOR_THROTTLE, 5, world);
    const top = Math.max(...frames.map(speedOf));
    expect(top).toBeLessThan(7);
    expect(top).toBeGreaterThan(5);
  });
});

describe('coasting, braking and reversing', () => {
  it('no throttle coasts to a full stop and stays at zero', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10, { vx: 10 }), IDLE, 6, world);
    let prev = 10;
    for (const f of frames) {
      const sp = speedOf(f);
      expect(sp).toBeGreaterThanOrEqual(0);
      expect(sp).toBeLessThanOrEqual(prev + 1e-12);
      prev = sp;
    }
    const tail = frames.slice(-60);
    for (const f of tail) expect(speedOf(f)).toBe(0);
    expect(last(frames).vx).toBeCloseTo(0, 9);
    expect(last(frames).vy).toBeCloseTo(0, 9);
  });

  it('brake slows a moving kart quickly', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10, { vx: 10 }), { throttle: -1, steer: 0, drift: false, boost: false }, 0.25, world);
    expect(last(frames).vx).toBeGreaterThan(0);
    expect(last(frames).vx).toBeLessThan(5);
  });

  it('holding brake after stopping reverses, capped at reverseMax', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(40, 10, { vx: 10 }), { throttle: -1, steer: 0, drift: false, boost: false }, 2, world);
    const slowest = Math.min(...frames.map((f) => f.vx));
    expect(slowest).toBeGreaterThanOrEqual(-KART.reverseMax - 1e-9);
    expect(last(frames).vx).toBeLessThan(0);
    expect(last(frames).vx).toBeCloseTo(-KART.reverseMax, 1);
  });

  it('reverse from rest is capped at reverseMax', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(40, 10), { throttle: -1, steer: 0, drift: false, boost: false }, 3, world);
    expect(Math.min(...frames.map((f) => f.vx))).toBeGreaterThanOrEqual(-KART.reverseMax - 1e-9);
    expect(speedOf(last(frames))).toBeCloseTo(KART.reverseMax, 1);
  });
});

describe('steering', () => {
  it('cannot turn when stationary', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10), { throttle: 0, steer: 1, drift: false, boost: false }, 1, world);
    expect(last(frames).heading).toBeCloseTo(0, 9);
    expect(last(frames).x).toBeCloseTo(5, 9);
  });

  it('turns clockwise (positive heading change) when moving forward with positive steer', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10, { vx: 8 }), { throttle: 0, steer: 1, drift: false, boost: false }, 0.5, world);
    expect(last(frames).heading).toBeGreaterThan(1);
  });

  it('steering is reversed while moving backwards', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(40, 10, { vx: -4 }), { throttle: 0, steer: 1, drift: false, boost: false }, 0.3, world);
    expect(last(frames).heading).toBeLessThan(-0.3);
  });
});

describe('drift and slip', () => {
  it('drifting at speed produces a slide (slip > 0.25) within ~0.5 s', () => {
    const world = makeWorld(box(80, 40));
    const frames = run(at(10, 20, { vx: 10 }), { throttle: 0, steer: 1, drift: true, boost: false }, 0.5, world);
    const firstSlide = frames.findIndex((f) => slipAngle(f) > KART.slideAngle);
    expect(firstSlide).toBeGreaterThanOrEqual(0);
    expect(isSliding(frames[firstSlide])).toBe(true);
  });

  it('without drift, a moderate turn keeps slip small (< 0.15)', () => {
    const world = makeWorld(box(80, 60));
    const frames = run(at(10, 30, { vx: 10 }), { throttle: 0, steer: 0.5, drift: false, boost: false }, 1, world);
    expect(Math.max(...frames.map(slipAngle))).toBeLessThan(0.15);
  });

  it('releasing drift restores grip and the kart snaps back to its heading', () => {
    const world = makeWorld(box(80, 40));
    const drifting = run(at(10, 20, { vx: 10 }), { throttle: 0, steer: 1, drift: true, boost: false }, 0.5, world);
    expect(slipAngle(last(drifting))).toBeGreaterThan(KART.slideAngle);
    const released = run(last(drifting), IDLE, 1, world);
    expect(slipAngle(last(released))).toBeLessThan(0.05);
  });
});

describe('collision', () => {
  // Wall: solid column at x = 10 across the full height. Centre-space face at 10.
  const wallRows = Array.from({ length: 12 }, (_, y) =>
    Array.from({ length: 30 }, (_, x) =>
      x === 0 || y === 0 || y === 11 || x === 29 || x === 10 ? '#' : '.',
    ).join(''),
  );

  it('driving at max speed into a wall never enters it and reflects the velocity', () => {
    const world = makeWorld(wallRows);
    const frames = run(at(3, 5, { vx: KART.maxSpeed }), FLOOR_THROTTLE, 5, world);
    for (const f of frames) {
      expect(Number.isFinite(f.x)).toBe(true);
      expect(world.surfaceAt(tileOf(f.x), tileOf(f.y))).not.toBe('solid');
      // Kart centre must stay at or left of the wall face minus the radius.
      expect(f.x + 0.5).toBeLessThanOrEqual(10 - KART.radius + 1e-9);
    }
    // The impact reversed the velocity at least once.
    expect(Math.min(...frames.map((f) => f.vx))).toBeLessThan(0);
  });

  it('wall contact does not tunnel even with a large frame count', () => {
    const world = makeWorld(wallRows);
    const frames = run(at(3, 5, { vx: KART.maxSpeed }), FLOOR_THROTTLE, 5, world, 30);
    expect(Math.max(...frames.map((f) => f.x))).toBeLessThanOrEqual(10 - KART.radius - 0.5 + 1e-9);
  });
});

describe('timestep handling', () => {
  it('dt above maxDt is clamped to maxDt', () => {
    const world = makeWorld(box(80, 20));
    const start = at(5, 10);
    expect(stepKart(start, FLOOR_THROTTLE, 1.0, world)).toEqual(
      stepKart(start, FLOOR_THROTTLE, KART.maxDt, world),
    );
    const moved = stepKart(start, FLOOR_THROTTLE, 1.0, world);
    expect(speedOf(moved)).toBeLessThanOrEqual(KART.accel * KART.maxDt + 1e-9);
  });

  it('negative dt leaves the kart in place', () => {
    const world = makeWorld(box(80, 20));
    const start = at(5, 10, { vx: 6 });
    const after = stepKart(start, FLOOR_THROTTLE, -1, world);
    expect(after.x).toBe(5);
    expect(after.y).toBe(10);
  });

  it('non-finite inputs never produce NaN', () => {
    const world = makeWorld(box(80, 20));
    const badState: KartState = {
      x: 5,
      y: 10,
      heading: Number.NaN,
      vx: Number.NaN,
      vy: Infinity,
      boost: Number.NaN,
      boosting: undefined as unknown as boolean,
    };
    const badInput = {
      throttle: Number.NaN,
      steer: Number.POSITIVE_INFINITY,
      drift: undefined as unknown as boolean,
      boost: undefined as unknown as boolean,
    };
    const out = stepKart(badState, badInput, Number.NaN, world);
    for (const v of [out.x, out.y, out.heading, out.vx, out.vy]) expect(Number.isFinite(v)).toBe(true);
    const out2 = stepKart(out, badInput, 0.05, world);
    for (const v of [out2.x, out2.y, out2.heading, out2.vx, out2.vy]) expect(Number.isFinite(v)).toBe(true);
    for (const st of [out, out2]) {
      expect(Number.isFinite(st.boost)).toBe(true);
      expect(st.boost).toBeGreaterThanOrEqual(0);
      expect(st.boost).toBeLessThanOrEqual(1);
    }
    expect(Number.isNaN(speedOf(out2))).toBe(false);
    expect(Number.isNaN(slipAngle(out2))).toBe(false);
  });

  it('results do not depend on how a second is split into frames', () => {
    const cases: Array<{ start: KartState; input: KartInput; world: KartWorld }> = [
      {
        start: at(10, 20, { vx: 6 }),
        input: { throttle: 0.5, steer: 0.4, drift: false, boost: false },
        world: makeWorld(box(80, 40)),
      },
      {
        start: at(10, 20, { vx: 10 }),
        input: { throttle: 0, steer: 1, drift: true, boost: false },
        world: makeWorld(box(80, 40)),
      },
      {
        start: at(10, 20, { vx: 6 }),
        input: { throttle: 1, steer: 0.3, drift: false, boost: true },
        world: makeWorld(box(80, 40)),
      },
    ];
    for (const { start, input, world } of cases) {
      const fine = run(start, input, 1, world, 60);
      const coarse = run(start, input, 1, world, 30);
      const a = last(fine);
      const b = last(coarse);
      expect(Math.abs(a.x - b.x)).toBeLessThan(0.05);
      expect(Math.abs(a.y - b.y)).toBeLessThan(0.05);
      expect(Math.abs(normalizeAngle(a.heading - b.heading))).toBeLessThan(0.05);
    }
  });
});

describe('boost', () => {
  it('raises the road top speed above 17 tiles/s, still within the boosted cap', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10), BOOST_THROTTLE, 2.4, world);
    const top = Math.max(...frames.map(speedOf));
    expect(top).toBeGreaterThan(17);
    expect(top).toBeLessThanOrEqual(KART.maxSpeed * KART.boostSpeedFactor + 1e-9);
  });

  it('drains to empty in about 2.5 s, then stops boosting', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10), BOOST_THROTTLE, 2.6, world);
    const at2 = frames[Math.round(2 * 60) - 1];
    expect(at2.boost).toBeCloseTo(1 - 2 * KART.boostDrain, 2);
    expect(isBoosting(at2)).toBe(true);
    const endIdx = frames.findIndex((f) => !isBoosting(f));
    expect(endIdx).toBeGreaterThan(0);
    expect(endIdx / 60).toBeCloseTo(1 / KART.boostDrain, 1);
    // The frame that empties the tank may recharge a sliver in its remaining substeps.
    expect(frames[endIdx].boost).toBeLessThan(0.01);
  });

  it('after the boost ends the speed falls smoothly to the normal cap', () => {
    const world = makeWorld(box(80, 20));
    // Boost until the energy is gone, then keep the throttle but release boost.
    const boosted = run(at(5, 10), BOOST_THROTTLE, 2.5, world);
    const frames = boosted.concat(run(last(boosted), FLOOR_THROTTLE, 2, world));
    const endIdx = frames.findIndex((f) => !isBoosting(f));
    expect(endIdx).toBeGreaterThan(0);
    // No instant drop: at most 1 tile/s per 0.1 s anywhere in the run.
    const step = 6; // 6 frames at 60 Hz = 0.1 s
    for (let i = step; i < frames.length; i++) {
      expect(speedOf(frames[i - step]) - speedOf(frames[i])).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(speedOf(frames[endIdx])).toBeGreaterThan(KART.maxSpeed + 4);
    expect(speedOf(last(frames))).toBeCloseTo(KART.maxSpeed, 1);
  });

  it('recharges at boostRecharge per second when not boosting', () => {
    const world = makeWorld(box(80, 20));
    const empty = at(5, 10, { boost: 0 });
    const frames = run(empty, IDLE, 3.5, world);
    expect(last(frames).boost).toBeCloseTo(3.5 * KART.boostRecharge, 2);
    expect(isBoosting(last(frames))).toBe(false);
  });

  it('drifting recharges faster than coasting', () => {
    const world = makeWorld(box(80, 40));
    const coast = run(at(10, 20, { vx: 10, boost: 0.2 }), IDLE, 1, world);
    const drift = run(at(10, 20, { vx: 10, boost: 0.2 }), { throttle: 0, steer: 1, drift: true, boost: false }, 1, world);
    const gainCoast = last(coast).boost - 0.2;
    const gainDrift = last(drift).boost - 0.2;
    expect(gainCoast).toBeGreaterThan(0);
    // Sliding only starts once the slip builds, so the gain is well short of 2.5x but clearly more.
    expect(gainDrift).toBeGreaterThan(gainCoast * 1.3);
  });

  it('does not start below the restart threshold, and starts once above it', () => {
    const world = makeWorld(box(80, 20));
    const low = stepKart(at(5, 10, { vx: 8, boost: KART.boostMinRestart - 0.05 }), BOOST_THROTTLE, 0.05, world);
    expect(isBoosting(low)).toBe(false);
    // Energy is still under the restart level for ~0.3 s of recharge, so no boost in that window.
    const frames = run(at(5, 10, { vx: 12, boost: KART.boostMinRestart - 0.05 }), BOOST_THROTTLE, 0.3, world);
    expect(frames.some(isBoosting)).toBe(false);
    expect(Math.max(...frames.map(speedOf))).toBeLessThanOrEqual(KART.maxSpeed + 1e-9);

    const high = stepKart(at(5, 10, { boost: KART.boostMinRestart + 0.05 }), BOOST_THROTTLE, 0.05, world);
    expect(isBoosting(high)).toBe(true);
  });

  it('keeps boosting between the restart threshold and empty once started', () => {
    const world = makeWorld(box(80, 20));
    const running = stepKart(at(5, 10, { vx: 12, boost: 0.1, boosting: true }), BOOST_THROTTLE, 0.05, world);
    expect(isBoosting(running)).toBe(true);
  });

  it('does not boost without throttle', () => {
    const world = makeWorld(box(80, 20));
    const frames = run(at(5, 10, { vx: 12 }), { throttle: 0, steer: 0, drift: false, boost: true }, 1, world);
    expect(frames.some(isBoosting)).toBe(false);
    expect(last(frames).boost).toBeCloseTo(1, 9);
    expect(Math.max(...frames.map(speedOf))).toBeLessThanOrEqual(12 + 1e-9);
  });

  it('boosting on offroad stays below the normal road top speed', () => {
    const world = makeWorld(box(80, 20, ','));
    const frames = run(at(5, 10), BOOST_THROTTLE, 4, world);
    const top = Math.max(...frames.map(speedOf));
    expect(top).toBeGreaterThan(7);
    expect(top).toBeLessThan(KART.maxSpeed);
    expect(top).toBeLessThanOrEqual(KART.maxSpeed * KART.offroadSpeedFactor * KART.boostSpeedFactor + 1e-9);
  });

  it('boosted acceleration reaches the road cap sooner than unboosted', () => {
    const world = makeWorld(box(80, 20));
    const plain = run(at(5, 10), FLOOR_THROTTLE, 0.5, world);
    const boosted = run(at(5, 10), BOOST_THROTTLE, 0.5, world);
    expect(speedOf(last(boosted))).toBeGreaterThan(speedOf(last(plain)) * 1.5);
  });
});

describe('angles, tiles and helpers', () => {
  it('normalizeAngle maps into (-PI, PI]', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(0.5)).toBeCloseTo(0.5, 12);
    expect(normalizeAngle(-2 * Math.PI - 0.25)).toBeCloseTo(-0.25, 9);
    expect(normalizeAngle(Number.NaN)).toBe(0);
  });

  it('lerpAngle takes the shortest arc across +-PI', () => {
    expect(Math.abs(lerpAngle(3, -3, 0.5))).toBeCloseTo(Math.PI, 5);
    expect(Math.abs(lerpAngle(-3, 3, 0.5))).toBeCloseTo(Math.PI, 5);
    // From 3 toward -3 the short way is increasing through PI, so 0.25 lands above 3.
    expect(lerpAngle(3, -3, 0.25)).toBeGreaterThan(3);
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    for (const t of [0, 0.3, 0.7, 1]) {
      const r = lerpAngle(2.5, -2.5, t);
      expect(r).toBeGreaterThan(-Math.PI);
      expect(r).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('directionFromHeading maps cardinal headings', () => {
    expect(directionFromHeading(0)).toBe('right');
    expect(directionFromHeading(Math.PI / 2)).toBe('down');
    expect(directionFromHeading(Math.PI)).toBe('left');
    expect(directionFromHeading(-Math.PI / 2)).toBe('up');
  });

  it('tileOf uses floor(p + 0.5)', () => {
    expect(tileOf(3)).toBe(3);
    expect(tileOf(3.49)).toBe(3);
    expect(tileOf(3.5)).toBe(4);
    expect(tileOf(2.6)).toBe(3);
    expect(tileOf(-0.4)).toBe(0);
  });

  it('speedOf and slipAngle measure velocity against heading', () => {
    expect(speedOf(at(0, 0, { vx: 3, vy: 4 }))).toBeCloseTo(5, 12);
    expect(slipAngle(at(0, 0, { vx: 0, vy: 5, heading: 0 }))).toBeCloseTo(Math.PI / 2, 9);
    expect(slipAngle(at(0, 0, { vx: 0.3, heading: 1 }))).toBe(0);
  });

  it('isSliding needs both a large slip angle and enough speed', () => {
    expect(isSliding(at(0, 0, { vx: 0, vy: 5 }))).toBe(true);
    expect(isSliding(at(0, 0, { vx: 0, vy: 2 }))).toBe(false);
    expect(isSliding(at(0, 0, { vx: 5, vy: 0 }))).toBe(false);
  });
});
