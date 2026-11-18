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
import { drawKart, drawKartBoost, drawKartPreview, kartRearOffset } from '../src/lib/kartSprite';

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

describe('sprites', () => {
  it('each model produces a different sequence of draw calls', () => {
    const logs = KART_MODEL_IDS.map((m) => drawLog(m).join('|'));
    expect(new Set(logs).size).toBe(KART_MODEL_IDS.length);
  });

  it('drawKart defaults to the classic kart', () => {
    expect(drawLog(DEFAULT_KART_MODEL)).toEqual(drawKartLogWithoutModel());
  });

  it('drawKartPreview clears, centres and draws without throwing on a stub context', () => {
    for (const m of KART_MODEL_IDS) {
      const { ctx, log } = recordingContext();
      expect(() => drawKartPreview(stubCanvas(100, 60, ctx), m, '#2563eb')).not.toThrow();
      expect(log[0]).toBe('clearRect(0,0,100,60)');
      expect(log).toContain('translate(50,30)');
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

  it('the boost flame starts at each model rear', () => {
    const logs = KART_MODEL_IDS.map((m) => {
      const { ctx, log } = recordingContext();
      drawKartBoost(ctx, 100, 100, 0, 40, 0, m);
      return log.join('|');
    });
    expect(new Set(logs).size).toBe(KART_MODEL_IDS.length);
    for (const m of KART_MODEL_IDS) {
      const { ctx, log } = recordingContext();
      drawKartBoost(ctx, 100, 100, 0, 40, 0, m);
      const back = kartRearOffset(m) * 40;
      expect(log).toContain(`moveTo(${back},${-0.2 * 40})`);
    }
  });
});

function drawKartLogWithoutModel(): string[] {
  const { ctx, log } = recordingContext();
  drawKart(ctx, 100, 100, 0, '#e11d48', 40);
  return log;
}
