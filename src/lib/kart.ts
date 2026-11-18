/**
 * Arcade top-down kart physics for the 2D tile map. Pure: no DOM, no clock.
 *
 * Coordinates: positions are in tile units. A kart at integer position p stands on tile p
 * (its sprite centre is at p + 0.5), so the tile under a float position is tileOf(p).
 * y grows downward (screen coords). Heading 0 = east (+x), PI/2 = south (+y).
 */

import { kartSpec, type KartModel } from './kartModels';

export interface KartState {
  x: number;
  y: number;
  /** Radians, 0 = east (+x), PI/2 = south (+y). Kept normalized to (-PI, PI]. */
  heading: number;
  vx: number;
  vy: number;
  /** Boost energy 0..1. Drains while boosting, recharges otherwise. */
  boost: number;
  /** True while the boost is active (held, with throttle, and energy left). */
  boosting: boolean;
}

/**
 * throttle -1..1 (negative = brake/reverse); steer -1..1 (positive = turn clockwise/right);
 * drift and boost are held buttons.
 */
export interface KartInput {
  throttle: number;
  steer: number;
  drift: boolean;
  boost: boolean;
}

export type Surface = 'road' | 'offroad' | 'solid';

/** Integer tile coordinates. Out-of-bounds should report 'solid'; the kart guards this too. */
export interface KartWorld {
  surfaceAt(tx: number, ty: number): Surface;
}

/** Tunables, in tiles and tiles/s (and rad/s for turning). */
export const KART = {
  /** Forward acceleration with full throttle (tiles/s^2). */
  accel: 16,
  /** Deceleration while braking against forward motion (tiles/s^2). */
  brake: 28,
  /** Rolling drag toward 0 speed with no throttle (tiles/s^2). */
  drag: 4,
  /** Maximum reverse speed (tiles/s). */
  reverseMax: 4,
  /** Top speed on road (tiles/s). Walking is ~7. */
  maxSpeed: 13,
  /** Multiplier on top speed when the kart centre is on offroad. */
  offroadSpeedFactor: 0.45,
  /** Deceleration applied while above the offroad cap (tiles/s^2). */
  offroadDecel: 20,
  /** Yaw rate at full steer and full speed (rad/s). */
  turnRate: 3.0,
  /** Forward speed at which steering reaches full authority (tiles/s). */
  fullTurnSpeed: 4,
  /** Yaw multiplier while drifting. */
  driftYawFactor: 1.35,
  /** Lateral grip (exponential decay rate of sideways velocity, 1/s). */
  grip: 14,
  /** Lateral grip while drifting (1/s). */
  driftGrip: 1.8,
  /** Drift only takes effect above this forward speed (tiles/s). */
  driftMinSpeed: 4,
  /** Forward speed lost per second while drifting (tiles/s^2). */
  driftSpeedLoss: 2,
  /** Forward speed below which holding brake switches to reversing (tiles/s). */
  reverseBrakeThreshold: 0.3,
  /** Collision radius around the kart centre (tiles). */
  radius: 0.35,
  /** Velocity component multiplier applied on a wall hit (negative reflection). */
  wallRestitution: 0.3,
  /** Frame dt is clamped to [0, maxDt] seconds. */
  maxDt: 0.1,
  /** Fixed integration substep (seconds). */
  substep: 1 / 120,
  /** slipAngle above this (rad) with speed above slideSpeed counts as sliding. */
  slideAngle: 0.25,
  /** Minimum speed (tiles/s) for isSliding. */
  slideSpeed: 3,
  /** Below this speed (tiles/s) slipAngle reports 0. */
  stoppedSpeed: 0.5,
  /** Top speed multiplier while boosting (offroad cap is scaled the same way). */
  boostSpeedFactor: 1.5,
  /** Acceleration multiplier while boosting. */
  boostAccelFactor: 2.2,
  /** Boost energy drained per second while boosting (energy is 0..1; 0.4 = 2.5 s of boost). */
  boostDrain: 0.4,
  /** Boost energy recharged per second when not boosting (about 7 s from empty). */
  boostRecharge: 1 / 7,
  /** Recharge multiplier while drifting: a reward for sliding. */
  boostDriftRechargeFactor: 2.5,
  /** Energy needed to start boosting again after running dry (avoids flicker at zero). */
  boostMinRestart: 0.15,
  /** Deceleration of speed above the road cap, e.g. once a boost ends (tiles/s^2). */
  boostFalloff: 6,
};

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Tile index under a float position: the sprite centre is at p + 0.5. */
export function tileOf(p: number): number {
  return Math.floor(p + 0.5);
}

/** Normalizes an angle into (-PI, PI]. Non-finite input yields 0. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Interpolates along the shortest arc between two angles. Result in (-PI, PI]. */
export function lerpAngle(a: number, b: number, t: number): number {
  const from = normalizeAngle(a);
  const delta = normalizeAngle(b - from);
  return normalizeAngle(from + delta * finiteOr(t, 0));
}

/** Dominant cardinal direction of a heading (screen coords: 'down' is +y). */
export function directionFromHeading(h: number): 'up' | 'down' | 'left' | 'right' {
  const a = normalizeAngle(h);
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (Math.abs(c) >= Math.abs(s)) return c >= 0 ? 'right' : 'left';
  return s >= 0 ? 'down' : 'up';
}

export function speedOf(s: KartState): number {
  return Math.hypot(finiteOr(s.vx, 0), finiteOr(s.vy, 0));
}

/** Absolute angle between velocity and heading, in [0, PI]. 0 when nearly stopped. */
export function slipAngle(s: KartState): number {
  const vx = finiteOr(s.vx, 0);
  const vy = finiteOr(s.vy, 0);
  if (Math.hypot(vx, vy) < KART.stoppedSpeed) return 0;
  return Math.abs(normalizeAngle(Math.atan2(vy, vx) - normalizeAngle(s.heading)));
}

/** True when the kart is visibly sliding (for tire marks and similar effects). */
export function isSliding(s: KartState): boolean {
  return slipAngle(s) > KART.slideAngle && speedOf(s) > KART.slideSpeed;
}

/** True while the kart is boosting. */
export function isBoosting(s: KartState): boolean {
  return s.boosting === true;
}

function sanitize(s: KartState): KartState {
  return {
    x: finiteOr(s.x, 0),
    y: finiteOr(s.y, 0),
    heading: normalizeAngle(s.heading),
    vx: finiteOr(s.vx, 0),
    vy: finiteOr(s.vy, 0),
    // A missing or non-finite energy counts as a full tank.
    boost: Number.isFinite(s.boost) ? clamp(s.boost, 0, 1) : 1,
    boosting: s.boosting === true,
  };
}

/** Tile lookup that treats non-finite coordinates and unknown surfaces as solid. */
function surfaceOf(world: KartWorld, tx: number, ty: number): Surface {
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return 'solid';
  const s = world.surfaceAt(tx, ty);
  return s === 'road' || s === 'offroad' ? s : 'solid';
}

/** True when the kart circle centred at (cx, cy) overlaps any solid tile. */
function overlapsSolid(world: KartWorld, cx: number, cy: number): boolean {
  const r = KART.radius;
  const x0 = Math.floor(cx - r);
  const x1 = Math.floor(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.floor(cy + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (surfaceOf(world, tx, ty) !== 'solid') continue;
      // Tile tx covers centre-space [tx, tx + 1); find the closest point on it to the centre.
      const nx = clamp(cx, tx, tx + 1);
      const ny = clamp(cy, ty, ty + 1);
      const dx = cx - nx;
      const dy = cy - ny;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

/** Moves v toward zero by amount, never crossing zero. */
function towardZero(v: number, amount: number): number {
  if (v > 0) return Math.max(0, v - amount);
  if (v < 0) return Math.min(0, v + amount);
  return 0;
}

/** KART tunables with one model's spec multipliers applied. */
interface KartTuning {
  accel: number;
  brake: number;
  maxSpeed: number;
  offroadSpeedFactor: number;
  turnRate: number;
  grip: number;
  driftGrip: number;
  boostSpeedFactor: number;
  boostDrain: number;
  boostDriftRechargeFactor: number;
}

/** Offroad never reaches the road cap, whatever a model's multiplier says. */
const MAX_OFFROAD_SPEED_FACTOR = 0.85;

/** Effective tunables for a model. Computed once per stepKart call, not per substep. */
function tuningFor(model: unknown): KartTuning {
  const spec = kartSpec(model);
  return {
    accel: KART.accel * spec.accel,
    brake: KART.brake * spec.brake,
    maxSpeed: KART.maxSpeed * spec.maxSpeed,
    offroadSpeedFactor: Math.min(
      MAX_OFFROAD_SPEED_FACTOR,
      KART.offroadSpeedFactor * spec.offroadSpeedFactor,
    ),
    turnRate: KART.turnRate * spec.turnRate,
    grip: KART.grip * spec.grip,
    driftGrip: KART.driftGrip * spec.driftGrip,
    boostSpeedFactor: KART.boostSpeedFactor * spec.boostSpeedFactor,
    boostDrain: KART.boostDrain * spec.boostDrain,
    boostDriftRechargeFactor: KART.boostDriftRechargeFactor * spec.boostDriftRecharge,
  };
}

function substep(
  s: KartState,
  input: KartInput,
  h: number,
  world: KartWorld,
  t: KartTuning,
): KartState {
  const cos = Math.cos(s.heading);
  const sin = Math.sin(s.heading);
  // Decompose velocity in the current heading frame.
  let fwd = s.vx * cos + s.vy * sin;
  let lat = -s.vx * sin + s.vy * cos;

  const offroad = surfaceOf(world, tileOf(s.x), tileOf(s.y)) === 'offroad';
  const th = input.throttle;
  // A running boost keeps going until its energy is gone; a stopped one needs the restart level.
  const boostOn =
    input.boost && th > 0 && (s.boosting ? s.boost > 0 : s.boost > KART.boostMinRestart);
  const cap =
    t.maxSpeed *
    (offroad ? t.offroadSpeedFactor : 1) *
    (boostOn ? t.boostSpeedFactor : 1);

  // Longitudinal control.
  if (th > 0) {
    const accel = t.accel * (boostOn ? KART.boostAccelFactor : 1);
    if (fwd < cap) fwd = Math.min(cap, fwd + accel * th * h);
  } else if (th < 0) {
    const amount = -th;
    if (fwd > KART.reverseBrakeThreshold) {
      fwd = Math.max(0, fwd - t.brake * amount * h);
    } else {
      fwd = Math.max(-KART.reverseMax, fwd - t.accel * amount * h);
    }
  } else {
    fwd = towardZero(fwd, KART.drag * h);
  }
  if (fwd > cap) {
    fwd = Math.max(cap, fwd - (offroad ? KART.offroadDecel : KART.boostFalloff) * h);
  }

  const driftActive = input.drift && Math.abs(fwd) > KART.driftMinSpeed;
  if (driftActive) fwd = towardZero(fwd, KART.driftSpeedLoss * h);

  // Energy: drains while boosting; otherwise recharges, faster while sliding.
  let boost = s.boost;
  if (boostOn) {
    boost = Math.max(0, boost - t.boostDrain * h);
  } else {
    const sliding = input.drift && isSliding(s);
    const rate = KART.boostRecharge * (sliding ? t.boostDriftRechargeFactor : 1);
    boost = Math.min(1, boost + rate * h);
  }
  const boosting = boostOn && boost > 0;

  // Lateral grip: sideways velocity bleeds off; low grip while drifting lets the kart slide.
  lat *= Math.exp(-(driftActive ? t.driftGrip : t.grip) * h);

  // Recompose velocity in the OLD heading frame. Turning below rotates the body, not the
  // velocity, so the next substep sees the difference as slip angle.
  let vx = fwd * cos - lat * sin;
  let vy = fwd * sin + lat * cos;

  // Steering: yaw rate scales with speed (no spinning in place), reverses when moving backwards.
  const turnFactor =
    clamp(Math.abs(fwd) / KART.fullTurnSpeed, 0, 1) * (fwd < 0 ? -1 : 1);
  const yawRate =
    clamp(input.steer, -1, 1) *
    t.turnRate *
    turnFactor *
    (driftActive ? KART.driftYawFactor : 1);
  const heading = normalizeAngle(s.heading + yawRate * h);

  // Axis-separated collision against solid tiles.
  let x = s.x + vx * h;
  if (overlapsSolid(world, x + 0.5, s.y + 0.5)) {
    x = s.x;
    vx = -vx * KART.wallRestitution;
  }
  let y = s.y + vy * h;
  if (overlapsSolid(world, x + 0.5, y + 0.5)) {
    y = s.y;
    vy = -vy * KART.wallRestitution;
  }

  return { x, y, heading, vx, vy, boost, boosting };
}

/**
 * Advances the kart by dt seconds. dt is clamped to [0, KART.maxDt] and integrated in
 * fixed substeps of KART.substep (the last one partial). Non-finite inputs are treated as 0
 * (or false for drift and boost). The result is always finite.
 *
 * `model` selects the car's spec multipliers (see kartModels.ts). Unknown ids use the default.
 */
export function stepKart(
  s: KartState,
  input: KartInput,
  dt: number,
  world: KartWorld,
  model: KartModel = 'kart',
): KartState {
  const tuning = tuningFor(model);
  const total = Number.isFinite(dt) ? clamp(dt, 0, KART.maxDt) : 0;
  const inp: KartInput = {
    throttle: Number.isFinite(input.throttle) ? clamp(input.throttle, -1, 1) : 0,
    steer: Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0,
    drift: input.drift === true,
    boost: input.boost === true,
  };

  let cur = sanitize(s);
  let remaining = total;
  while (remaining > 1e-9) {
    const h = Math.min(KART.substep, remaining);
    cur = substep(cur, inp, h, world, tuning);
    remaining -= h;
  }
  return cur;
}
