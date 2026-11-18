/**
 * Pixel-art karts for the world canvas. Each model is a hand-drawn art-pixel map facing east
 * (see SPRITES). Maps are rotated to one of 32 headings by nearest-neighbour sampling, so every
 * heading is still crisp, hard-outlined pixels like the rest of the game. Pure drawing, no
 * state: the caller decides where the kart is and which way it faces.
 */

import { rampFrom } from './pixelArt';
import type { KartModel } from './kartModels';

/** A square of art pixels, row-major. null is transparent. */
export interface PixelGrid {
  size: number;
  px: (string | null)[];
}

const OUTLINE = '#0f172a';
const TYRE = '#1e2433';
const TYRE_HI = '#3a4256';
const SEAT = '#151a26';
const METAL = '#4b5468';
const METAL_HI = '#8b93a6';
const HEADLIGHT = '#f6dc8a';
const TAIL_LIGHT = '#d9534f';
const SHADOW = 'rgba(15, 23, 42, 0.3)';

/** Art pixels per tile edge. A 48px world tile is therefore 3 screen px per art pixel. */
const ART_PER_TILE = 16;

/**
 * Headings are snapped to this many steps per turn. Each (model, body, step) is rotated once and
 * then cached, so 32 steps is what keeps the cost of turning a kart bounded.
 */
const STEPS = 32;

/**
 * Cap on each cache. Bodies are a handful of colours and models four, so real use stays far
 * below this; the cap only stops a run of unusual colours growing the maps without limit.
 */
const MAX_CACHE = 512;

const FLAME_SIZE = 36;

/**
 * Sprite maps, facing east (nose on the right). Only the top half is authored, including the
 * centre row; `mirror` adds the bottom half so each sprite is exactly symmetric about its
 * length axis. Sizes are odd on both axes so the centre is a pixel centre, which is what keeps
 * the 180-degree turn exact.
 *
 * The driver's head (9x7 art px) is drawn over the centre, so each sprite keeps body colour
 * visible around it: at least 5 columns ahead of the head, 3 behind it, and 2 rows above and
 * below. Wheels and wings sit outside that, and every structural part is at least 2 px thick so
 * it survives rotation.
 *
 *   .  transparent        o  outline           d b l h  body dark / base / light / hi
 *   w  tyre               t  tyre highlight    s  seat / cockpit well
 *   m  metal              n  metal highlight   y  headlight     r  tail light
 *
 * Shading is by form, not by a fixed light direction: a sprite turns with its heading, so a
 * top-left light would be wrong after rotation. Outermost body rows are d, the centre line along
 * the length is l (rear) / h (front), and the rest of the body is b.
 */
const KART_TOP = [
  '.oooooo.......oooooo.',
  '.ootwoo.......ootwoo.',
  '.oowwooooooooooowwoo.',
  '.ooooodddddddddooooo.',
  'ooddddbbbbbbbbbddddoo',
  'ommbbbbbbbbbbbbbbbmmo',
  'ormbbbbsssssssbbbymmo',
  'ommbbbbsssssssbbbbmmo',
  'ommllllssssssshhhhmmo',
];

/** Formula car: a long body with a pointed nose, wheels at the corners and wide wings. */
const RACER_TOP = [
  'onmooooooo.....ooooooonmo',
  'onmoootwoooooooootwooonmo',
  'onmodowwodddddddowwooonmo',
  'onmoboooobbbbbbboooooonmo',
  'onmobddddsssssssddoooonmo',
  'onmobbbbbsssssssbbyooonmo',
  'onmobbbbbsssssssbbbdoonmo',
  'onmolllllssssssshhhhdonmo',
];

/** Dune buggy: a chunky box with knobbly wheels, roll cage hoops and a spare tyre at the back. */
const BUGGY_TOP = [
  '.oowotoo.....oowotoo.',
  '.ootwwoo.....oowwwoo.',
  '.oowwwooooooooowwwoo.',
  '.oooooodddddddooooooo',
  'oodddddbbbbbbbddddmmo',
  'otwbmmbbbbbbbbbmmbmmo',
  'owwbmmbsssssssbmmbmmo',
  'owwbmmbsssssssbmmymmo',
  'omwlmmlssssssshmmhmmo',
];

/**
 * Drift coupe: a low body with a rounded nose, a racing stripe down the middle, a dark windscreen
 * and a tall rear spoiler on a stand.
 */
const DRIFTER_TOP = [
  'oooooooooo..oooooo...',
  'ommoootwoo..ootwoo...',
  'ommooowwoooooowwooo..',
  'ommodooooddddoooodo..',
  'ommobddddbbbbddddboo.',
  'ommobbbbbbbbbbbbbbdoo',
  'ommmbbbsssssssbssbydo',
  'ommmhhhssssssshsshhho',
  'ommmhhhssssssshsshhho',
];

/** Mirrors the top half (which includes the centre row) onto the bottom. */
function mirror(top: string[]): string[] {
  return [...top, ...top.slice(0, -1).reverse()];
}

const SPRITES: Record<KartModel, string[]> = {
  kart: mirror(KART_TOP),
  racer: mirror(RACER_TOP),
  buggy: mirror(BUGGY_TOP),
  drifter: mirror(DRIFTER_TOP),
};

/**
 * Boost flame frames, 7 long by 5 tall, facing west from a front edge on the right. Frames differ
 * in length and flicker. Legend: 1 core, 2 hot, 3 mid, 4 outer tips.
 */
const FLAME_FRAMES: string[][] = [
  ['...3...', '..434..', '4332112', '..434..', '...3...'],
  ['....3..', '..434..', '..43212', '..434..', '....3..'],
  ['..3....', '.4343..', '4332212', '.4343..', '..3....'],
];

const FLAME_LEGEND: Record<string, string> = {
  '1': '#fff4c2',
  '2': '#ffd04a',
  '3': '#ff8a2a',
  '4': '#d9432b',
};

const pixelCache = new Map<string, PixelGrid>();
const canvasCache = new Map<string, HTMLCanvasElement | null>();

/** Sets a cache entry, clearing the whole map first if it has grown past the cap. */
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * Quantises a heading (radians, 0 = east, PI/2 = south) to one of STEPS sprite steps. The
 * modulo keeps negative and multi-turn headings on the same step.
 */
function headingStep(heading: number): number {
  const turn = 2 * Math.PI;
  const normalised = ((heading % turn) + turn) % turn;
  return Math.round(normalised / (turn / STEPS)) % STEPS;
}

/** Screen pixels per art pixel, never less than 1. */
function artScale(cell: number): number {
  return Math.max(1, Math.round(cell / ART_PER_TILE));
}

/**
 * Square grid size for a sprite of the given dimensions. It must hold the sprite at any
 * rotation, so the diagonal plus a margin. Its parity matches the sprite's (sprites are odd), so
 * the rotation centre is a pixel centre. Sample points then land on pixel centres too, which keeps
 * 90 and 180 degree turns exact instead of flipping on floating-point noise at pixel edges.
 */
function spriteSize(w: number, h: number): number {
  let size = Math.ceil(Math.hypot(w, h)) + 2;
  if (size % 2 !== w % 2) size++;
  return size;
}

/** Palette for a kart body: the ramp is derived from the rider's colour, the rest is fixed. */
function palette(body: string): Record<string, string> {
  const ramp = rampFrom(body);
  return {
    o: OUTLINE,
    d: ramp.dark,
    b: ramp.base,
    l: ramp.light,
    h: ramp.hi,
    w: TYRE,
    t: TYRE_HI,
    s: SEAT,
    m: METAL,
    n: METAL_HI,
    y: HEADLIGHT,
    r: TAIL_LIGHT,
  };
}

/**
 * Fills single-pixel gaps that nearest-neighbour rotation opens in thin lines. A transparent
 * pixel is filled only when the two pixels on one axis match, so the fill is symmetric under a
 * 180 degree turn.
 */
function fillHoles(px: (string | null)[], size: number): (string | null)[] {
  const at = (i: number, j: number): string | null =>
    i < 0 || j < 0 || i >= size || j >= size ? null : px[j * size + i];
  const out = px.slice();
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (px[j * size + i] !== null) continue;
      const left = at(i - 1, j);
      const right = at(i + 1, j);
      const up = at(i, j - 1);
      const down = at(i, j + 1);
      if (left !== null && left === right) out[j * size + i] = left;
      else if (up !== null && up === down) out[j * size + i] = up;
    }
  }
  return out;
}

/**
 * Rotates a w x h source into a size x size square by nearest-neighbour inverse mapping: each
 * destination pixel centre is rotated back by the step angle and the source pixel under it is
 * copied. `anchor` is the source point that sits on the rotation centre. `offset` shifts the
 * source in its own unrotated frame before rotating, which is how the flame is hung off the
 * kart's rear.
 */
function rotatePixels(
  src: (string | null)[],
  w: number,
  h: number,
  size: number,
  step: number,
  anchor: [number, number],
  offset: [number, number],
): (string | null)[] {
  const turn = (step / STEPS) * 2 * Math.PI;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const half = size / 2;
  const out: (string | null)[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Destination pixel centre, relative to the rotation centre.
      const x = i + 0.5 - half;
      const y = j + 0.5 - half;
      // Rotate back by the step angle to find the source point under this pixel.
      const sx = Math.floor(anchor[0] + cos * x + sin * y - offset[0]);
      const sy = Math.floor(anchor[1] - sin * x + cos * y - offset[1]);
      out.push(sx >= 0 && sy >= 0 && sx < w && sy < h ? src[sy * w + sx] : null);
    }
  }
  return fillHoles(out, size);
}

/**
 * A kart's art pixels at one heading step, for the given body colour. Pure and memoised, so it
 * can be unit-tested without a DOM.
 */
export function kartPixels(model: KartModel, body: string, step: number): PixelGrid {
  const key = `${model}|${body}|${step}`;
  const hit = pixelCache.get(key);
  if (hit) return hit;
  const rows = SPRITES[model] ?? SPRITES.kart;
  const pal = palette(body);
  const w = rows[0].length;
  const h = rows.length;
  const src = rows.flatMap((row) => [...row].map((ch) => (ch === '.' ? null : pal[ch])));
  const size = spriteSize(w, h);
  // The sprite's centre is the rotation centre, so the kart is drawn around (cx, cy).
  const px = rotatePixels(src, w, h, size, step, [w / 2, h / 2], [0, 0]);
  return remember(pixelCache, key, { size, px });
}

/**
 * Left edge of a model's sprite at step 0, in art px from its centre (negative = behind). Longer
 * sprites can reach further back than kartRearOffset, and the flame must start at the real rear.
 */
function spriteRearEdge(model: KartModel): number {
  const rows = SPRITES[model] ?? SPRITES.kart;
  const w = rows[0].length;
  let minCol = w;
  for (const row of rows) {
    const i = row.search(/[^.]/);
    if (i >= 0 && i < minCol) minCol = i;
  }
  return minCol - w / 2;
}

/**
 * The boost flame for one animation frame at one heading step. It sits in a FLAME_SIZE square
 * centred on the kart, with its front edge at the model's rear offset. That is why it can be
 * drawn with the same top-left maths as a kart.
 */
export function flamePixels(model: KartModel, frame: number, step: number): PixelGrid {
  const key = `${model}|${frame}|${step}`;
  const hit = pixelCache.get(key);
  if (hit) return hit;
  const rows = FLAME_FRAMES[frame] ?? FLAME_FRAMES[0];
  const w = rows[0].length;
  const h = rows.length;
  const src = rows.flatMap((row) => [...row].map((ch) => (ch === '.' ? null : (FLAME_LEGEND[ch] ?? null))));
  // Anchor on the flame's front edge, vertically centred. Offsetting the source by the front edge
  // puts that edge in the kart's unrotated frame, where the flame starts.
  const front = Math.min(kartRearOffset(model) * ART_PER_TILE, spriteRearEdge(model));
  const px = rotatePixels(src, w, h, FLAME_SIZE, step, [w, h / 2], [front, 0]);
  return remember(pixelCache, key, { size: FLAME_SIZE, px });
}

/**
 * Kart body colour for a rider's kart: their avatar's outfit colour when it is a plain hex colour,
 * otherwise a colour picked deterministically from their id so each kart stays recognisable.
 */
const FALLBACK_BODY = ['#e11d48', '#f59e0b', '#16a34a', '#2563eb', '#9333ea', '#0891b2'];

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

/**
 * Paints a grid with its centre on (cx, cy), one art pixel per `s` screen pixels. With a DOM the
 * grid is drawn from a cached offscreen canvas, scaled with smoothing off so the pixels stay hard.
 * Without one (tests, workers) it falls back to one fillRect per opaque pixel. `tint` replaces
 * every opaque colour, which is how the ground shadow reuses the sprite's silhouette.
 */
function paintGrid(
  ctx: CanvasRenderingContext2D,
  key: string,
  grid: PixelGrid,
  cx: number,
  cy: number,
  s: number,
  tint?: string,
): void {
  const extent = grid.size * s;
  const x0 = Math.round(cx - extent / 2);
  const y0 = Math.round(cy - extent / 2);
  const canvas = gridCanvas(key, grid, tint);
  if (canvas) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, x0, y0, extent, extent);
    return;
  }
  grid.px.forEach((c, i) => {
    if (!c) return;
    ctx.fillStyle = tint ?? c;
    ctx.fillRect(x0 + (i % grid.size) * s, y0 + Math.floor(i / grid.size) * s, s, s);
  });
}

/**
 * Offscreen canvas holding a grid at one pixel per art pixel, cached by key. Null when there is no
 * DOM or no 2D context, which tells paintGrid to fall back to fillRect.
 */
function gridCanvas(key: string, grid: PixelGrid, tint?: string): HTMLCanvasElement | null {
  const hit = canvasCache.get(key);
  if (hit !== undefined) return hit;
  let canvas: HTMLCanvasElement | null = null;
  if (typeof document !== 'undefined') {
    const made = document.createElement('canvas');
    const g = made.getContext('2d');
    if (g) {
      made.width = grid.size;
      made.height = grid.size;
      grid.px.forEach((c, i) => {
        if (!c) return;
        g.fillStyle = tint ?? c;
        g.fillRect(i % grid.size, Math.floor(i / grid.size), 1, 1);
      });
      canvas = made;
    }
  }
  if (canvasCache.size >= MAX_CACHE) canvasCache.clear();
  canvasCache.set(key, canvas);
  return canvas;
}

/**
 * Draws a kart centred on (cx, cy) in screen pixels, nose pointing along `heading` (0 = east,
 * PI/2 = south). `cell` is the tile size in pixels, so one art pixel is cell/16 screen pixels.
 * `model` picks the silhouette.
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
  const s = artScale(cell);
  const step = headingStep(heading);
  const key = `${model}|${body}|${step}`;
  const grid = kartPixels(model, body, step);
  ctx.save();
  // Ground shadow: the same silhouette, nudged one art pixel down-right in screen space so it
  // stays put while the kart turns.
  paintGrid(ctx, `${key}|shadow`, grid, cx + s, cy + s, s, SHADOW);
  paintGrid(ctx, key, grid, cx, cy, s);
  ctx.restore();
}

/**
 * Exhaust flame behind a boosting kart. It cycles through three pixel frames every 60 ms, so the
 * flicker is a few steps of animation rather than a smooth tween. `now` is a millisecond clock
 * (Date.now()) that drives the frame choice.
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
  const s = artScale(cell);
  const step = headingStep(heading);
  const frame = ((Math.floor(now / 60) % FLAME_FRAMES.length) + FLAME_FRAMES.length) % FLAME_FRAMES.length;
  const grid = flamePixels(model, frame, step);
  ctx.save();
  paintGrid(ctx, `flame|${model}|${frame}|${step}`, grid, cx, cy, s);
  ctx.restore();
}

/**
 * Draws a model facing east, centred, at the largest whole art-pixel scale that fits the canvas,
 * for selector thumbnails. Clears the canvas first. Does nothing if the canvas has no 2D context.
 */
export function drawKartPreview(canvas: HTMLCanvasElement, model: KartModel, body: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // Fit the tight box of opaque pixels at step 0, so the thumbnail gets the largest whole scale.
  const grid = kartPixels(model, body, 0);
  let x0 = grid.size;
  let x1 = -1;
  let y0 = grid.size;
  let y1 = -1;
  grid.px.forEach((c, i) => {
    if (!c) return;
    const x = i % grid.size;
    const y = Math.floor(i / grid.size);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  });
  if (x1 < 0) return;
  const s = Math.max(1, Math.floor(Math.min(w / (x1 - x0 + 1), h / (y1 - y0 + 1))));
  // Centre the box, not the grid: shift the grid so the box's middle lands on the canvas middle.
  const dx = (x0 + x1 + 1) / 2 - grid.size / 2;
  const dy = (y0 + y1 + 1) / 2 - grid.size / 2;
  drawKart(ctx, w / 2 - dx * s, h / 2 - dy * s, 0, body, s * ART_PER_TILE, model);
}
