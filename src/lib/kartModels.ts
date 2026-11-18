/**
 * Kart models: the selectable car types. Each model is a set of multipliers on the KART tunables
 * in kart.ts (1 = unchanged) plus display info for the selector. Pure data, no DOM.
 */

export type KartModel = 'kart' | 'racer' | 'buggy' | 'drifter';

export const KART_MODEL_IDS: readonly KartModel[] = ['kart', 'racer', 'buggy', 'drifter'];

export const DEFAULT_KART_MODEL: KartModel = 'kart';

/** Multipliers applied to KART tunables, 1 = unchanged. */
export interface KartSpec {
  /** Top speed on road. */
  maxSpeed: number;
  /** Forward acceleration. */
  accel: number;
  /** Braking deceleration. */
  brake: number;
  /** Yaw rate at full steer. */
  turnRate: number;
  /** Lateral grip. */
  grip: number;
  /** Lateral grip while drifting. */
  driftGrip: number;
  /** Multiplier on KART.offroadSpeedFactor (clamped in kart.ts so offroad stays below road). */
  offroadSpeedFactor: number;
  /** Multiplier on KART.boostSpeedFactor. */
  boostSpeedFactor: number;
  /** Multiplier on KART.boostDrain (higher drains faster). */
  boostDrain: number;
  /** Multiplier on KART.boostDriftRechargeFactor. */
  boostDriftRecharge: number;
}

export interface KartModelInfo {
  id: KartModel;
  name: string;
  tagline: string;
  spec: KartSpec;
  /** Selector bars, 1 (worst) to 5 (best). Derived from the spec, see kartModels.test.ts. */
  stats: { speed: 1 | 2 | 3 | 4 | 5; accel: 1 | 2 | 3 | 4 | 5; handling: 1 | 2 | 3 | 4 | 5; offroad: 1 | 2 | 3 | 4 | 5 };
}

const NEUTRAL: KartSpec = {
  maxSpeed: 1,
  accel: 1,
  brake: 1,
  turnRate: 1,
  grip: 1,
  driftGrip: 1,
  offroadSpeedFactor: 1,
  boostSpeedFactor: 1,
  boostDrain: 1,
  boostDriftRecharge: 1,
};

export const KART_MODELS: Record<KartModel, KartModelInfo> = {
  kart: {
    id: 'kart',
    name: 'Classic Kart',
    tagline: 'Balanced all-rounder',
    spec: { ...NEUTRAL },
    stats: { speed: 3, accel: 3, handling: 3, offroad: 3 },
  },
  racer: {
    id: 'racer',
    name: 'Formula',
    tagline: 'Fastest on tarmac, lost on grass',
    spec: {
      ...NEUTRAL,
      maxSpeed: 1.15,
      accel: 1.05,
      grip: 1.25,
      turnRate: 0.85,
      offroadSpeedFactor: 0.75,
      driftGrip: 1.2,
    },
    stats: { speed: 5, accel: 3, handling: 2, offroad: 1 },
  },
  buggy: {
    id: 'buggy',
    name: 'Dune Buggy',
    tagline: 'Built for the rough stuff',
    spec: {
      ...NEUTRAL,
      maxSpeed: 0.9,
      accel: 1.2,
      offroadSpeedFactor: 1.7,
      turnRate: 1.05,
      grip: 0.9,
    },
    stats: { speed: 2, accel: 4, handling: 3, offroad: 5 },
  },
  drifter: {
    id: 'drifter',
    name: 'Drift King',
    tagline: 'Slides and turns on a dime',
    spec: {
      ...NEUTRAL,
      maxSpeed: 0.97,
      turnRate: 1.15,
      grip: 0.85,
      driftGrip: 0.7,
      boostDriftRecharge: 1.5,
    },
    stats: { speed: 3, accel: 3, handling: 5, offroad: 2 },
  },
};

export function isKartModel(v: unknown): v is KartModel {
  return typeof v === 'string' && (KART_MODEL_IDS as readonly string[]).includes(v);
}

/** Spec for a model id; invalid or missing ids fall back to the default model. */
export function kartSpec(model: unknown): KartSpec {
  return isKartModel(model) ? KART_MODELS[model].spec : KART_MODELS[DEFAULT_KART_MODEL].spec;
}
