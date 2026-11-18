/**
 * Top-down kart drawing for the world canvas. Pure canvas drawing, no state: the caller decides
 * where the kart is and which way it faces.
 */

import { mixHex } from './pixelArt';
import type { KartModel } from './kartModels';

const OUTLINE = '#0f172a';
const WHEEL = '#1e293b';
const BUMPER = '#334155';
const HEADLIGHT = '#fde68a';
const KNOB = '#475569';
const GLASS = '#334155';

/** Used when the rider's avatar has no usable shirt colour. */
const FALLBACK_BODY = ['#e11d48', '#f59e0b', '#16a34a', '#2563eb', '#9333ea', '#0891b2'];

/**
 * Body colour for a rider's kart: their avatar's outfit colour when it is a plain hex colour,
 * otherwise a colour picked deterministically from their id so each kart stays recognisable.
 */
export function kartBodyColor(seed: string, outfitColor?: string): string {
  if (outfitColor && /^#[0-9a-f]{6}$/i.test(outfitColor)) return outfitColor;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_BODY[h % FALLBACK_BODY.length];
}

/**
 * Where the rear of each model sits, as a fraction of the cell (negative = behind centre).
 * The exhaust flame starts here.
 */
export function kartRearOffset(model: KartModel): number {
  switch (model) {
    case 'racer':
      return -0.54;
    case 'buggy':
      return -0.56;
    case 'drifter':
      return -0.53;
    case 'kart':
    default:
      return -0.55;
  }
}

/** Fill then outline a rectangle given in cell fractions. */
function plate(ctx: CanvasRenderingContext2D, u: number, x: number, y: number, w: number, h: number): void {
  ctx.fillRect(x * u, y * u, w * u, h * u);
  ctx.strokeRect(x * u, y * u, w * u, h * u);
}

/** Fill only, no outline (panels and lights). */
function fill(ctx: CanvasRenderingContext2D, u: number, x: number, y: number, w: number, h: number): void {
  ctx.fillRect(x * u, y * u, w * u, h * u);
}

/** Ground shadow, offset a touch so the kart reads as sitting on the tile. */
function shadow(ctx: CanvasRenderingContext2D, u: number, rx: number, ry: number): void {
  ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
  ctx.beginPath();
  ctx.ellipse(0.03 * u, 0.04 * u, rx * u, ry * u, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** The original kart: four wheels, a chassis, a seat well and a rear bumper. */
function drawClassic(ctx: CanvasRenderingContext2D, u: number, body: string): void {
  shadow(ctx, u, 0.5, 0.36);

  // Four wheels, poking out past the body on each side.
  ctx.fillStyle = WHEEL;
  for (const [wx, wy] of [
    [0.3, -0.3],
    [0.3, 0.3],
    [-0.3, -0.3],
    [-0.3, 0.3],
  ] as const) {
    plate(ctx, u, wx - 0.08, wy - 0.06, 0.16, 0.12);
  }

  // Chassis: flat body colour with a hard outline, like the rest of the pixel art.
  ctx.fillStyle = body;
  plate(ctx, u, -0.45, -0.3, 0.9, 0.6);

  // Lit top-front panel: a lighter band of the body colour on the upper half of the nose.
  ctx.fillStyle = mixHex(body, '#ffffff', 0.45);
  fill(ctx, u, 0.14, -0.22, 0.26, 0.1);

  // Seat well (the avatar is drawn over it).
  ctx.fillStyle = mixHex(body, OUTLINE, 0.45);
  fill(ctx, u, -0.16, -0.2, 0.32, 0.4);

  // Headlights at the nose.
  ctx.fillStyle = HEADLIGHT;
  fill(ctx, u, 0.4, -0.2, 0.06, 0.09);
  fill(ctx, u, 0.4, 0.11, 0.06, 0.09);

  // Rear spoiler / bumper, sticking out behind the body.
  ctx.fillStyle = BUMPER;
  plate(ctx, u, -0.53, -0.25, 0.1, 0.5);
}

/**
 * Formula car: long narrow body with a pointed nose, exposed wheels outside the body, a front
 * wing and a wide rear wing.
 */
function drawRacer(ctx: CanvasRenderingContext2D, u: number, body: string): void {
  shadow(ctx, u, 0.52, 0.27);

  // Exposed wheels, outside the narrow body.
  ctx.fillStyle = WHEEL;
  for (const [wx, wy] of [
    [-0.34, -0.34],
    [-0.34, 0.21],
    [0.12, -0.34],
    [0.12, 0.21],
  ] as const) {
    plate(ctx, u, wx, wy, 0.22, 0.13);
  }

  // Body: flat sides, pointed nose cone.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.42 * u, -0.2 * u);
  ctx.lineTo(0.2 * u, -0.2 * u);
  ctx.lineTo(0.5 * u, -0.03 * u);
  ctx.lineTo(0.5 * u, 0.03 * u);
  ctx.lineTo(0.2 * u, 0.2 * u);
  ctx.lineTo(-0.42 * u, 0.2 * u);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Lit spine down the middle of the top.
  ctx.fillStyle = mixHex(body, '#ffffff', 0.45);
  fill(ctx, u, -0.3, -0.14, 0.44, 0.06);

  // Cockpit opening.
  ctx.fillStyle = mixHex(body, OUTLINE, 0.45);
  ctx.beginPath();
  ctx.ellipse(0.02 * u, 0, 0.13 * u, 0.1 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Front wing and rear wing with a small stand.
  ctx.fillStyle = BUMPER;
  plate(ctx, u, 0.48, -0.27, 0.07, 0.54);
  plate(ctx, u, -0.44, -0.04, 0.1, 0.08);
  plate(ctx, u, -0.54, -0.27, 0.1, 0.54);

  // Headlights just behind the nose tip.
  ctx.fillStyle = HEADLIGHT;
  fill(ctx, u, 0.36, -0.07, 0.05, 0.05);
  fill(ctx, u, 0.36, 0.02, 0.05, 0.05);
}

/**
 * Dune buggy: chunky boxy body, oversized knobbly wheels, a roll cage and a spare tyre at the
 * back.
 */
function drawBuggy(ctx: CanvasRenderingContext2D, u: number, body: string): void {
  shadow(ctx, u, 0.46, 0.4);

  // Oversized wheels with two knobs each on the outer edge.
  for (const [wx, wy] of [
    [-0.27, -0.3],
    [0.27, -0.3],
    [-0.27, 0.3],
    [0.27, 0.3],
  ] as const) {
    const x = wx - 0.14;
    const y = wy - 0.1;
    ctx.fillStyle = WHEEL;
    plate(ctx, u, x, y, 0.28, 0.2);
    ctx.fillStyle = KNOB;
    const outer = wy < 0 ? y - 0.04 : y + 0.2 - 0.01;
    fill(ctx, u, x + 0.03, outer, 0.06, 0.05);
    fill(ctx, u, x + 0.16, outer, 0.06, 0.05);
  }

  // Boxy chassis.
  ctx.fillStyle = body;
  plate(ctx, u, -0.34, -0.27, 0.68, 0.54);

  // Lit panel on the nose and a dark seat well.
  ctx.fillStyle = mixHex(body, '#ffffff', 0.45);
  fill(ctx, u, 0.08, -0.2, 0.22, 0.12);
  ctx.fillStyle = mixHex(body, OUTLINE, 0.45);
  fill(ctx, u, -0.14, -0.18, 0.26, 0.36);

  // Roll cage: dark bars over the cockpit.
  ctx.strokeStyle = OUTLINE;
  ctx.strokeRect(-0.2 * u, -0.21 * u, 0.36 * u, 0.42 * u);
  ctx.beginPath();
  ctx.moveTo(-0.2 * u, 0);
  ctx.lineTo(0.16 * u, 0);
  ctx.stroke();

  // Headlights at the nose.
  ctx.fillStyle = HEADLIGHT;
  fill(ctx, u, 0.34, -0.2, 0.06, 0.1);
  fill(ctx, u, 0.34, 0.1, 0.06, 0.1);

  // Spare tyre bolted to the back.
  ctx.fillStyle = WHEEL;
  ctx.beginPath();
  ctx.arc(-0.42 * u, 0, 0.11 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = BUMPER;
  ctx.beginPath();
  ctx.arc(-0.42 * u, 0, 0.05 * u, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Drift coupe: low, wide body with a lighter racing stripe down its length, a dark cabin,
 * side skirts and a big rear spoiler.
 */
function drawDrifter(ctx: CanvasRenderingContext2D, u: number, body: string): void {
  shadow(ctx, u, 0.5, 0.32);

  // Low wheels tucked under the body.
  ctx.fillStyle = WHEEL;
  for (const [wx, wy] of [
    [-0.26, -0.3],
    [-0.26, 0.3],
    [0.22, -0.3],
    [0.22, 0.3],
  ] as const) {
    plate(ctx, u, wx - 0.08, wy - 0.06, 0.16, 0.12);
  }

  // Coupe body: wide, tapering to a rounded nose.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.45 * u, -0.25 * u);
  ctx.lineTo(0.14 * u, -0.29 * u);
  ctx.lineTo(0.4 * u, -0.14 * u);
  ctx.lineTo(0.47 * u, 0);
  ctx.lineTo(0.4 * u, 0.14 * u);
  ctx.lineTo(0.14 * u, 0.29 * u);
  ctx.lineTo(-0.45 * u, 0.25 * u);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Racing stripe along the length, lighter than the body.
  ctx.fillStyle = mixHex(body, '#ffffff', 0.4);
  fill(ctx, u, -0.44, -0.045, 0.86, 0.09);

  // Cabin and windscreen.
  ctx.fillStyle = mixHex(body, OUTLINE, 0.5);
  plate(ctx, u, -0.14, -0.19, 0.3, 0.38);
  ctx.fillStyle = GLASS;
  fill(ctx, u, 0.12, -0.15, 0.06, 0.3);

  // Side skirts along both flanks.
  ctx.fillStyle = mixHex(body, OUTLINE, 0.35);
  fill(ctx, u, -0.36, -0.3, 0.58, 0.05);
  fill(ctx, u, -0.36, 0.25, 0.58, 0.05);

  // Headlights at the nose.
  ctx.fillStyle = HEADLIGHT;
  fill(ctx, u, 0.38, -0.12, 0.05, 0.06);
  fill(ctx, u, 0.38, 0.06, 0.05, 0.06);

  // Big rear spoiler on two stands.
  ctx.fillStyle = BUMPER;
  plate(ctx, u, -0.44, -0.1, 0.1, 0.2);
  plate(ctx, u, -0.52, -0.3, 0.1, 0.6);
}

/**
 * Draws a kart centred on (cx, cy) in screen pixels, nose pointing along `heading` (0 = east,
 * PI/2 = south). `cell` is the tile size in pixels; every dimension is a fraction of it, so the
 * kart is about 0.9 x 0.6 tiles. `model` picks the silhouette.
 */
export function drawKart(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  heading: number,
  body: string,
  cell: number,
  model: KartModel = 'kart',
): void {
  ctx.save();
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.rotate(heading);
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;

  switch (model) {
    case 'racer':
      drawRacer(ctx, cell, body);
      break;
    case 'buggy':
      drawBuggy(ctx, cell, body);
      break;
    case 'drifter':
      drawDrifter(ctx, cell, body);
      break;
    case 'kart':
    default:
      drawClassic(ctx, cell, body);
      break;
  }

  ctx.restore();
}

const FLAME_OUTER = '#f97316';
const FLAME_INNER = '#fde047';

/**
 * Exhaust flame behind a boosting kart: two flickering triangles (orange outside, yellow inside)
 * trailing from the model's rear (see kartRearOffset). `now` is a millisecond clock (Date.now())
 * that drives the flicker.
 */
export function drawKartBoost(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  heading: number,
  cell: number,
  now: number,
  model: KartModel = 'kart',
): void {
  const u = cell;
  const outer = 0.5 + 0.5 * Math.sin(now / 45);
  const inner = 0.5 + 0.5 * Math.sin(now / 31 + 1.7);
  const back = kartRearOffset(model) * u;
  ctx.save();
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.rotate(heading);

  ctx.fillStyle = FLAME_OUTER;
  ctx.beginPath();
  ctx.moveTo(back, -0.2 * u);
  ctx.lineTo(back - (0.4 + 0.25 * outer) * u, 0);
  ctx.lineTo(back, 0.2 * u);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = FLAME_INNER;
  ctx.beginPath();
  ctx.moveTo(back, -0.1 * u);
  ctx.lineTo(back - (0.25 + 0.2 * inner) * u, 0);
  ctx.lineTo(back, 0.1 * u);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * Draws a model facing right, centred and scaled to fit the canvas, for selector thumbnails.
 * Clears the canvas first. Does nothing if the canvas has no 2D context.
 */
export function drawKartPreview(canvas: HTMLCanvasElement, model: KartModel, body: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // The longest model is about 1.1 tiles nose to tail, so this leaves a small margin.
  const cell = Math.min(w, h) / 1.3;
  drawKart(ctx, w / 2, h / 2, 0, body, cell, model);
}
