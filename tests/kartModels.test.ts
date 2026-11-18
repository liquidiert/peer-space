import { describe, expect, it } from 'vitest';
import { KART, stepKart, slipAngle, speedOf, type KartInput, type KartState, type KartWorld } from '../src/lib/kart';
import {
  DEFAULT_KART_MODEL,
  KART_MODELS,
  KART_MODEL_IDS,
  isKartModel,
  kartSpec,
  type KartModel,
} from '../src/lib/kartModels';
import {
  drawKart,
  drawKartBoost,
  drawKartPreview,
  flamePixels,
  kartPixels,
  kartRearOffset,
  type PixelGrid,
} from '../src/lib/kartSprite';

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

function box(width: number, height: number, inner = '.'): string[] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : inner,
    ).join(''),
  );
}

function at(x: number, y: number, extra: Partial<KartState> = {}): KartState {
  return { x, y, heading: 0, vx: 0, vy: 0, boost: 1, boosting: false, ...extra };
}

const ROAD = makeWorld(box(120, 40));
const GRASS = makeWorld(box(120, 40, ','));
const FLOOR: KartInput = { throttle: 1, steer: 0, drift: false, boost: false };

/** Steps frames of 1/hz seconds with the given model and returns the state after each frame. */
function run(
  s: KartState,
  input: KartInput,
  seconds: number,
  world: KartWorld,
  model: KartModel,
  hz = 60,
): KartState[] {
  const frames: KartState[] = [];
  let cur = s;
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    cur = stepKart(cur, input, 1 / hz, world, model);
    frames.push(cur);
  }
  return frames;
}

/** Highest speed reached on road with full throttle. */
function roadTop(model: KartModel): number {
  return Math.max(...run(at(5, 20), FLOOR, 5, ROAD, model).map(speedOf));
}

/** Highest speed reached on grass with full throttle. */
function offroadTop(model: KartModel): number {
  return Math.max(...run(at(5, 20), FLOOR, 5, GRASS, model).map(speedOf));
}

/** Seconds from rest to 10 tiles/s with full throttle on road. */
function accelTo10(model: KartModel): number {
  const dt = 1 / 240;
  let cur = at(5, 20);
  let t = 0;
  while (speedOf(cur) < 10 && t < 10) {
    cur = stepKart(cur, FLOOR, dt, ROAD, model);
    t += dt;
  }
  return t;
}

/** Turning radius in tiles at 8 tiles/s with full steer: speed / yaw rate, one substep. */
function turnRadius(model: KartModel): number {
  const start = at(5, 20, { vx: 8 });
  const next = stepKart(start, { throttle: 0, steer: 1, drift: false, boost: false }, KART.substep, ROAD, model);
  const yawRate = next.heading / KART.substep;
  return 8 / yawRate;
}

/** Peak slip angle while drifting at 10 tiles/s with full steer for half a second. */
function driftSlip(model: KartModel): number {
  const frames = run(
    at(10, 20, { vx: 10 }),
    { throttle: 0, steer: 1, drift: true, boost: false },
    0.5,
    ROAD,
    model,
  );
  return Math.max(...frames.map(slipAngle));
}

const METRICS = {
  /** Higher is better. */
  roadTop: (m: KartModel) => roadTop(m),
  /** Higher is better. */
  offroadTop: (m: KartModel) => offroadTop(m),
  /** Lower is better. */
  accelTo10: (m: KartModel) => accelTo10(m),
  /** Lower is better. */
  radius: (m: KartModel) => turnRadius(m),
} as const;

const HIGHER_IS_BETTER: Record<keyof typeof METRICS, boolean> = {
  roadTop: true,
  offroadTop: true,
  accelTo10: false,
  radius: false,
};

describe('registry', () => {
  it('lists every model once, with the default among them', () => {
    expect(new Set(KART_MODEL_IDS).size).toBe(KART_MODEL_IDS.length);
    expect(KART_MODEL_IDS).toContain(DEFAULT_KART_MODEL);
    expect(Object.keys(KART_MODELS).sort()).toEqual([...KART_MODEL_IDS].sort());
  });

  it('every spec multiplier is finite and positive, with the default neutral', () => {
    for (const id of KART_MODEL_IDS) {
      const spec = KART_MODELS[id].spec;
      for (const v of Object.values(spec)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
    expect(Object.values(KART_MODELS.kart.spec).every((v) => v === 1)).toBe(true);
  });

  it('every model has a name, tagline and stats within 1..5', () => {
    for (const id of KART_MODEL_IDS) {
      const info = KART_MODELS[id];
      expect(info.id).toBe(id);
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.tagline.length).toBeGreaterThan(0);
      for (const v of Object.values(info.stats)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(5);
      }
    }
  });

  it('isKartModel accepts only registered ids', () => {
    for (const id of KART_MODEL_IDS) expect(isKartModel(id)).toBe(true);
    for (const v of ['tank', '', 'Kart', null, undefined, 3, {}]) expect(isKartModel(v)).toBe(false);
  });

  it('kartSpec returns the model spec and falls back to the default for invalid ids', () => {
    expect(kartSpec('racer')).toBe(KART_MODELS.racer.spec);
    expect(kartSpec('bogus')).toBe(KART_MODELS[DEFAULT_KART_MODEL].spec);
    expect(kartSpec(undefined)).toBe(KART_MODELS[DEFAULT_KART_MODEL].spec);
    expect(kartSpec(42)).toBe(KART_MODELS[DEFAULT_KART_MODEL].spec);
  });
});

describe('physics by model', () => {
  it('the default model matches the no-model call exactly', () => {
    const input: KartInput = { throttle: 0.7, steer: 0.4, drift: true, boost: false };
    const start = at(5, 20, { vx: 9, vy: 1 });
    const withDefault = run(start, input, 1, ROAD, DEFAULT_KART_MODEL);
    let cur = start;
    const omitted: KartState[] = [];
    for (let i = 0; i < 60; i++) {
      cur = stepKart(cur, input, 1 / 60, ROAD);
      omitted.push(cur);
    }
    expect(withDefault).toEqual(omitted);
  });

  it('an invalid model id behaves like the default', () => {
    const start = at(5, 20, { vx: 6 });
    const input: KartInput = { throttle: 1, steer: 0.5, drift: false, boost: false };
    expect(stepKart(start, input, 0.5, ROAD, 'nope' as KartModel)).toEqual(
      stepKart(start, input, 0.5, ROAD, 'kart'),
    );
  });

  it('racer has the highest road top speed', () => {
    const tops = KART_MODEL_IDS.map((m) => [m, roadTop(m)] as const);
    const best = tops.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(best[0]).toBe('racer');
  });

  it('buggy has the highest offroad top speed, still below its road top speed', () => {
    const offs = KART_MODEL_IDS.map((m) => [m, offroadTop(m)] as const);
    const best = offs.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(best[0]).toBe('buggy');
    expect(offroadTop('buggy')).toBeLessThan(roadTop('buggy'));
    // The offroad cap stays below the road cap, so the ratio is bounded.
    expect(offroadTop('buggy') / roadTop('buggy')).toBeLessThanOrEqual(0.85 + 1e-9);
  });

  it('racer is the worst on grass', () => {
    const offs = KART_MODEL_IDS.map((m) => [m, offroadTop(m)] as const);
    const worst = offs.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(worst[0]).toBe('racer');
  });

  it('drifter slides more than the classic kart at the same speed', () => {
    expect(driftSlip('drifter')).toBeGreaterThan(driftSlip('kart'));
  });

  it('drifter turns tighter than the classic kart at the same speed', () => {
    expect(turnRadius('drifter')).toBeLessThan(turnRadius('kart'));
  });

  it('drifter recharges boost faster while sliding', () => {
    const drift: KartInput = { throttle: 0, steer: 1, drift: true, boost: false };
    const gain = (m: KartModel) => {
      const frames = run(at(10, 20, { vx: 10, boost: 0.2 }), drift, 1, ROAD, m);
      return frames[frames.length - 1].boost - 0.2;
    };
    expect(gain('drifter')).toBeGreaterThan(gain('kart') * 1.2);
  });

  it('every model has a trade-off: some other model beats it on some metric', () => {
    const table = Object.fromEntries(
      KART_MODEL_IDS.map((m) => [m, Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, f(m)]))]),
    ) as Record<KartModel, Record<keyof typeof METRICS, number>>;
    for (const m of KART_MODEL_IDS) {
      const beaten = KART_MODEL_IDS.some((o) =>
        o !== m &&
        (Object.keys(METRICS) as Array<keyof typeof METRICS>).some((k) =>
          HIGHER_IS_BETTER[k] ? table[o][k] > table[m][k] : table[o][k] < table[m][k],
        ),
      );
      expect(beaten).toBe(true);
    }
  });

  it('the selector stats order the models the same way the physics does', () => {
    const measured = {
      speed: Object.fromEntries(KART_MODEL_IDS.map((m) => [m, roadTop(m)])) as Record<KartModel, number>,
      offroad: Object.fromEntries(KART_MODEL_IDS.map((m) => [m, offroadTop(m)])) as Record<KartModel, number>,
      accel: Object.fromEntries(KART_MODEL_IDS.map((m) => [m, -accelTo10(m)])) as Record<KartModel, number>,
      handling: Object.fromEntries(KART_MODEL_IDS.map((m) => [m, -turnRadius(m)])) as Record<KartModel, number>,
    };
    for (const stat of ['speed', 'offroad', 'accel', 'handling'] as const) {
      for (const a of KART_MODEL_IDS) {
        for (const b of KART_MODEL_IDS) {
          if (KART_MODELS[a].stats[stat] > KART_MODELS[b].stats[stat]) {
            expect(measured[stat][a], `${stat}: ${a} vs ${b}`).toBeGreaterThan(measured[stat][b]);
          }
        }
      }
    }
  });
});

/** Records every canvas call as a string, so two drawings can be compared. */
function recordingContext(): { ctx: CanvasRenderingContext2D; log: string[] } {
  const log: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => (...args: unknown[]) => {
        log.push(`${String(prop)}(${args.map((a) => String(a)).join(',')})`);
      },
      set: (_t, prop, value) => {
        log.push(`${String(prop)}=${String(value)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, log };
}

function stubCanvas(width: number, height: number, ctx: CanvasRenderingContext2D | null): HTMLCanvasElement {
  return { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function drawLog(model: KartModel, body = '#e11d48'): string[] {
  const { ctx, log } = recordingContext();
  drawKart(ctx, 100, 100, 0, body, 40, model);
  return log;
}

/** Positions (column, row) of every pixel of one colour. */
function pixelsOf(grid: PixelGrid, colour: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  grid.px.forEach((c, i) => {
    if (c === colour) out.push([i % grid.size, Math.floor(i / grid.size)]);
  });
  return out;
}

const HEADLIGHT_COLOUR = '#f6dc8a';

describe('sprites', () => {
  it('each model is a different pixel sprite', () => {
    const sprites = KART_MODEL_IDS.map((m) => kartPixels(m, '#e11d48', 0).px.join('|'));
    expect(new Set(sprites).size).toBe(KART_MODEL_IDS.length);
  });

  it('each model draws a different sequence of calls', () => {
    const logs = KART_MODEL_IDS.map((m) => drawLog(m).join('|'));
    expect(new Set(logs).size).toBe(KART_MODEL_IDS.length);
  });

  it('drawKart defaults to the classic kart', () => {
    expect(drawLog(DEFAULT_KART_MODEL)).toEqual(drawKartLogWithoutModel());
  });

  it('step 0 faces east: headlights on the right half only', () => {
    for (const m of KART_MODEL_IDS) {
      const { size } = kartPixels(m, '#e11d48', 0);
      const lights = pixelsOf(kartPixels(m, '#e11d48', 0), HEADLIGHT_COLOUR);
      expect(lights.length, m).toBeGreaterThan(0);
      for (const [x] of lights) expect(x, m).toBeGreaterThanOrEqual(size / 2);
    }
  });

  it('step 16 faces west: headlights on the left half only', () => {
    for (const m of KART_MODEL_IDS) {
      const { size } = kartPixels(m, '#e11d48', 16);
      const lights = pixelsOf(kartPixels(m, '#e11d48', 16), HEADLIGHT_COLOUR);
      expect(lights.length, m).toBeGreaterThan(0);
      for (const [x] of lights) expect(x, m).toBeLessThan(size / 2);
    }
  });

  it('step 16 is exactly step 0 turned 180 degrees', () => {
    for (const m of KART_MODEL_IDS) {
      const a = kartPixels(m, '#e11d48', 0);
      const b = kartPixels(m, '#e11d48', 16);
      expect(b.size).toBe(a.size);
      for (let i = 0; i < a.px.length; i++) {
        expect(b.px[i], `${m} pixel ${i}`).toBe(a.px[a.px.length - 1 - i]);
      }
    }
  });

  it('step 8 (south) puts the headlights in the bottom half', () => {
    for (const m of KART_MODEL_IDS) {
      const { size } = kartPixels(m, '#e11d48', 8);
      const lights = pixelsOf(kartPixels(m, '#e11d48', 8), HEADLIGHT_COLOUR);
      expect(lights.length, m).toBeGreaterThan(0);
      for (const [, y] of lights) expect(y, m).toBeGreaterThanOrEqual(size / 2);
    }
  });

  it('changing the body colour keeps the silhouette', () => {
    const a = kartPixels('kart', '#e11d48', 0).px;
    const b = kartPixels('kart', '#2563eb', 0).px;
    expect(a.map((c) => c === null)).toEqual(b.map((c) => c === null));
    expect(a.filter((c, i) => c !== b[i]).length).toBeGreaterThan(0);
  });

  it('drawKart on a plain recording context does not throw', () => {
    for (const m of KART_MODEL_IDS) {
      const { ctx } = recordingContext();
      expect(() => drawKart(ctx, 100, 100, 1.3, '#e11d48', 48, m)).not.toThrow();
    }
  });

  it('drawKartBoost draws a flame for every model and frame without throwing', () => {
    for (const m of KART_MODEL_IDS) {
      for (const now of [0, 60, 120, 5000]) {
        const { ctx } = recordingContext();
        expect(() => drawKartBoost(ctx, 100, 100, 2.4, 48, now, m)).not.toThrow();
      }
    }
  });

  it('drawKartPreview clears and draws without throwing on a stub context', () => {
    for (const m of KART_MODEL_IDS) {
      const { ctx, log } = recordingContext();
      expect(() => drawKartPreview(stubCanvas(100, 60, ctx), m, '#2563eb')).not.toThrow();
      expect(log[0]).toBe('clearRect(0,0,100,60)');
      expect(log.some((l) => l.startsWith('fillRect('))).toBe(true);
    }
  });

  it('drawKartPreview is a no-op when the canvas has no 2D context', () => {
    expect(() => drawKartPreview(stubCanvas(100, 60, null), 'racer', '#2563eb')).not.toThrow();
  });

  it('each model has its own rear offset, all behind centre', () => {
    const offsets = KART_MODEL_IDS.map((m) => kartRearOffset(m));
    expect(new Set(offsets).size).toBe(KART_MODEL_IDS.length);
    for (const o of offsets) {
      expect(o).toBeLessThan(-0.5);
      expect(o).toBeGreaterThan(-0.6);
    }
  });

  it('the flame sits entirely behind the kart, for every model', () => {
    for (const m of KART_MODEL_IDS) {
      const flame = flamePixels(m, 0, 0);
      const half = flame.size / 2;
      const cols = pixelsOf(flame, '#ffd04a').concat(pixelsOf(flame, '#ff8a2a'), pixelsOf(flame, '#d9432b'));
      expect(cols.length, m).toBeGreaterThan(0);
      for (const [x] of cols) expect(x, m).toBeLessThan(half);
    }
  });

  it('the flame front edge meets the rear of the sprite (or kartRearOffset, whichever is further back)', () => {
    for (const m of KART_MODEL_IDS) {
      const body = kartPixels(m, '#e11d48', 0);
      // Left edge of the rearmost opaque column of the sprite, relative to the kart centre.
      const rearmost = Math.min(...body.px.map((c, i) => (c ? i % body.size : Infinity)));
      const spriteRear = rearmost - body.size / 2;
      const target = Math.min(kartRearOffset(m) * 16, spriteRear);
      const flame = flamePixels(m, 0, 0);
      // Right edge of the frontmost opaque flame column, relative to the kart centre.
      const frontmost = Math.max(...flame.px.map((c, i) => (c ? i % flame.size : -1)));
      const flameFront = frontmost + 1 - flame.size / 2;
      expect(Math.abs(flameFront - target), m).toBeLessThan(1.5);
    }
  });

  it('the three flame frames differ', () => {
    for (const m of KART_MODEL_IDS) {
      const frames = [0, 1, 2].map((f) => flamePixels(m, f, 0).px.join('|'));
      expect(new Set(frames).size).toBe(3);
    }
  });

  it('the sprite stays symmetric about its length axis', () => {
    for (const m of KART_MODEL_IDS) {
      const { size, px } = kartPixels(m, '#e11d48', 0);
      // Step 0 is unrotated, so the sprite's top and bottom rows mirror each other in the grid.
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const mirrored = px[(size - 1 - j) * size + i];
          expect(px[j * size + i] === null, `${m} ${i},${j}`).toBe(mirrored === null);
        }
      }
    }
  });

  it('the boost flame with no model draws the same as the kart', () => {
    const a = recordingContext();
    drawKartBoost(a.ctx, 100, 100, 0, 48, 0);
    const b = recordingContext();
    drawKartBoost(b.ctx, 100, 100, 0, 48, 0, 'kart');
    expect(a.log).toEqual(b.log);
  });
});

function drawKartLogWithoutModel(): string[] {
  const { ctx, log } = recordingContext();
  drawKart(ctx, 100, 100, 0, '#e11d48', 40);
  return log;
}
