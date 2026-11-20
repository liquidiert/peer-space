import type { AvatarCustomization, Direction, PresenceStatus } from '../types';
import {
  BODY_CODES,
  BODY_FRAMES,
  BODY_H,
  BODY_PASSING_COLUMN,
  BODY_SIDE_FACING,
  BODY_W,
  type BodyFrame,
  type BodyRole,
} from './avatarBodyData';
import { ACCENT, LIGHT_TINT, mixHex, rampFrom, safeHex, SHADOW_TINT, type Ramp } from './pixelArt';

/**
 * The character sprite, in one place.
 *
 * Both the world canvas (SpatialCanvas) and the Avatar Studio preview (AvatarBuilder) draw
 * through this function. They previously each had their own idea of what an avatar looked
 * like - one canvas, one HTML/CSS - which meant every change to the character had to be
 * made twice and the two drifted apart until the Studio was showing something the map never
 * rendered. A single scale-parameterised draw makes that drift impossible.
 *
 * The body is baked pixel art, generated offline by pixel_generator (bake_avatar.py) into
 * avatarBodyData.ts. It is drawn in five roles - outline, skin, shirt, pants, shoes - and each
 * role is recoloured from the user's customization at draw time, so one baked body serves
 * every outfit and skin tone. Everything that carries identity on top of the body is drawn
 * in code: the face, then hair, hats and glasses over it. Those are positioned from the
 * frame's head box, so they bob with the head through the walk cycle.
 *
 * The sprite box is the body plus 3 art pixels on each side (room for the ground shadow, the
 * walk sway and volumetric hair), PAD_TOP above (for hair and hats), and 2 below for the shadow.
 * Everything is measured in art pixels, and the art pixel is deliberately the same size as the
 * tiles' and furniture's. Rendering the character at a smaller art pixel to shrink it would
 * make it the one part of the scene drawn on a finer grid, which reads as a sprite from a
 * different game.
 */

/** Empty art pixels either side of the body: room for the ground shadow and the walk sway. */
const PAD_X = 3;
/** Empty art pixels above the body: room for afros, hats and pom-poms. */
const PAD_TOP = 5;

export const AV_W = BODY_W + 2 * PAD_X;
export const AV_H = PAD_TOP + BODY_H + 2;
export const AV_INK = "#1e293b";

/**
 * The standing pose. BODY_PASSING_COLUMN is column 1, which is also the idle frame; the walk
 * cycle is columns 0, 1, 2, 1.
 */
const IDLE_COLUMN = BODY_PASSING_COLUMN;
const WALK_COLUMNS = [0, 1, 2, 1];
const IDLE_DOWN: BodyFrame = BODY_FRAMES.down[IDLE_COLUMN];

/**
 * Art row of the ground line: the row just below the idle feet. The shadow sits on it and does
 * not move with the walk bob.
 */
export const AV_GROUND_Y = PAD_TOP + IDLE_DOWN.feetY + 1;
/** Art row of the top of the idle head outline. Hair and hats rise above it. */
export const AV_HEAD_TOP_Y = PAD_TOP + IDLE_DOWN.headBox.y;
/** Art row at the middle of the body: the centre for anything that wraps the whole figure. */
export const AV_BODY_CENTER_Y = PAD_TOP + BODY_H / 2;

/**
 * The head block, in art pixels, for karts: the full sprite width, from the top of the box down
 * to the bottom row of the idle head. Half-open: x in [x0, x1), y in [y0, y1). It is symmetric
 * about the box centre, so mirroring keeps it in place.
 */
const HEAD_CLIP = {
  x0: 0,
  x1: AV_W,
  y0: 0,
  y1: PAD_TOP + IDLE_DOWN.headBox.y + IDLE_DOWN.headBox.h,
};
/** Size in art pixels of the head block drawn by {@link drawAvatarHead}. */
export const AVATAR_HEAD_SIZE = {
  w: HEAD_CLIP.x1 - HEAD_CLIP.x0,
  h: HEAD_CLIP.y1 - HEAD_CLIP.y0,
};

export interface AvatarSpriteOptions {
  /** Which way the character faces. Defaults to 'down' (toward the camera). */
  direction?: Direction;
  /** Walk cycle frame 0-3, cycling columns 0, 1, 2, 1 of the baked frames; -1 stands still. */
  walkPhase?: number;
  /** Draws the presence pip over the head's top-right corner when set. */
  presence?: PresenceStatus | null;
  /** Draws the status emoji chip against the head's top-left corner. */
  showEmoji?: boolean;
}

const PRESENCE_COLORS: Record<string, string> = {
  available: ACCENT.green,
  busy: ACCENT.orange,
  dnd: ACCENT.red,
};

/** One horizontal run of identical body codes, in sprite art pixels: [x, y, w, code]. */
type BodyRun = [x: number, y: number, w: number, code: string];

/** The runs of one frame: each row's non-transparent codes merged into single rectangles. */
function runsOf(frame: BodyFrame): BodyRun[] {
  const runs: BodyRun[] = [];
  frame.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      let end = x + 1;
      while (end < row.length && row[end] === row[x]) end++;
      if (row[x] !== ".") runs.push([PAD_X + x, PAD_TOP + y, end - x, row[x]]);
      x = end;
    }
  });
  return runs;
}

// Precomputed once, so a draw is only colour lookups and fillRects.
const BODY_RUNS = {
  down: BODY_FRAMES.down.map(runsOf),
  side: BODY_FRAMES.side.map(runsOf),
  up: BODY_FRAMES.up.map(runsOf),
};

/** The four tones of a ramp, indexed by the baked shade 0..3 (dark, base, light, hi). */
const tonesOf = (ramp: Ramp) => [ramp.dark, ramp.base, ramp.light, ramp.hi];

/**
 * Each baked body code as a colour, recoloured from the customization. The skin, shirt and
 * pants use the shared ramps; the shoes are a fixed step darker than the outfit.
 */
function bodyPalette(avatar: AvatarCustomization | undefined) {
  const skinBase = safeHex(avatar?.skinColor, "#f0b090");
  // The shade is warmed toward a brown-red, so the jaw, cheeks and neck read as skin, not stubble.
  const skin: Ramp = { ...rampFrom(skinBase), dark: mixHex(skinBase, "#7a3a2a", 0.32) };
  const outfit = rampFrom(safeHex(avatar?.outfitColor, "#5b86cf"));
  const trouser = rampFrom(mixHex(outfit.base, SHADOW_TINT, 0.42));
  const tones: Record<Exclude<BodyRole, "outline" | "shoes">, string[]> = {
    skin: tonesOf(skin),
    shirt: tonesOf(outfit),
    pants: tonesOf(trouser),
  };
  // A lighter toe on each shoe, so the foot reads as a shoe rather than a stub of colour.
  const shoe = mixHex(outfit.base, AV_INK, 0.65);
  const shoeTones = [
    shoe,
    mixHex(shoe, LIGHT_TINT, 0.2),
    mixHex(shoe, LIGHT_TINT, 0.35),
    mixHex(shoe, LIGHT_TINT, 0.35),
  ];
  const codes: Record<string, string> = {};
  for (const [code, [role, shade]] of Object.entries(BODY_CODES)) {
    codes[code] =
      role === "outline" ? AV_INK : role === "shoes" ? shoeTones[shade] : tones[role][shade];
  }
  return { codes, skin };
}

/**
 * @param ox,oy  Top-left of the sprite box, in device pixels. Snap this to whole pixels:
 *               drawing art pixels at fractional offsets is what makes a pixel character
 *               shimmer as it moves.
 * @param scale  Device pixels per art pixel. 3 on the map; larger for previews.
 */
export function drawAvatarSprite(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  scale: number,
  avatar: AvatarCustomization | undefined,
  options: AvatarSpriteOptions = {}
) {
  paintAvatar(ctx, ox, oy, scale, avatar, options, false);
}

/**
 * Draws only the head (face, hair and hat) of the character, for a kart driver whose head
 * shows above the seat. Same palette and rows as {@link drawAvatarSprite}; no body below the
 * head, shadow, presence pip or status chip.
 *
 * @param cx,cy  Centre of the head block, in device pixels. The block is
 *               {@link AVATAR_HEAD_SIZE} art pixels times `scale`, rounded to whole pixels.
 * @param scale  Device pixels per art pixel.
 */
export function drawAvatarHead(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scale: number,
  avatar: AvatarCustomization | undefined,
  options: Pick<AvatarSpriteOptions, 'direction'> = {}
) {
  const left = Math.round(cx - (AVATAR_HEAD_SIZE.w * scale) / 2);
  const top = Math.round(cy - (AVATAR_HEAD_SIZE.h * scale) / 2);
  // Art pixel (HEAD_CLIP.x0, HEAD_CLIP.y0) is the block's top-left corner.
  paintAvatar(
    ctx,
    left - HEAD_CLIP.x0 * scale,
    top - HEAD_CLIP.y0 * scale,
    scale,
    avatar,
    { direction: options.direction },
    true
  );
}

function paintAvatar(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  scale: number,
  avatar: AvatarCustomization | undefined,
  options: AvatarSpriteOptions,
  headOnly: boolean
) {
  const { direction = "down", walkPhase = -1, presence = null, showEmoji = false } = options;
  const clip = headOnly ? HEAD_CLIP : null;

  // --- Frame ------------------------------------------------------------------------------
  // Side frames are drawn facing BODY_SIDE_FACING; the other side is the same art mirrored.
  // Each frame carries its own walk bob, so the body is never offset here.
  const facingSide = direction === "left" || direction === "right";
  const mirror = facingSide && direction !== BODY_SIDE_FACING;
  const view = direction === "up" ? "up" : facingSide ? "side" : "down";
  const column =
    walkPhase >= 0 && walkPhase < WALK_COLUMNS.length ? WALK_COLUMNS[walkPhase] : IDLE_COLUMN;
  const frame = BODY_FRAMES[view][column];
  const { codes, skin } = bodyPalette(avatar);

  // The head's origin in art pixels. Everything on the head is positioned from here, so it
  // follows the frame's 1px bob.
  const hb = frame.headBox;
  const hx = PAD_X + hb.x;
  const hy = PAD_TOP + hb.y;

  /** Fill art pixels, mirrored horizontally when the character faces the other side. */
  const f = (x: number, y: number, w: number, h: number, color: string) => {
    let ax = mirror ? AV_W - x - w : x;
    let ay = y;
    let aw = w;
    let ah = h;
    if (clip) {
      // Head-only: trim to the head block, so anything hanging out of it is cut at the edge.
      const x0 = Math.max(ax, clip.x0);
      const x1 = Math.min(ax + aw, clip.x1);
      const y0 = Math.max(ay, clip.y0);
      const y1 = Math.min(ay + ah, clip.y1);
      if (x1 <= x0 || y1 <= y0) return;
      ax = x0;
      ay = y0;
      aw = x1 - x0;
      ah = y1 - y0;
    }
    ctx.fillStyle = color;
    ctx.fillRect(ox + ax * scale, oy + ay * scale, aw * scale, ah * scale);
  };
  /** Translucent variant, for blush and lenses. */
  const fa = (x: number, y: number, w: number, h: number, color: string, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    f(x, y, w, h, color);
    ctx.restore();
  };

  // --- Ground shadow ----------------------------------------------------------------------
  // A translucent 9x2 patch under the feet, drawn first so the body sits on top of it. Its
  // ends are at half strength so the edge fades instead of ending in a hard step. It is placed
  // from the ground line, so it does not bob with the walk. Skipped in head-only mode: a kart's
  // head has no feet to stand on.
  if (!headOnly) {
    const shadow = (x: number, w: number, alpha: number) => {
      ctx.fillStyle = `rgba(20, 26, 44, ${alpha})`;
      ctx.fillRect(ox + x * scale, oy + (AV_GROUND_Y - 1) * scale, w * scale, 2 * scale);
    };
    const shadowLeft = PAD_X + IDLE_DOWN.centerX - 4;
    shadow(shadowLeft, 1, 0.14);
    shadow(shadowLeft + 1, 7, 0.28);
    shadow(shadowLeft + 8, 1, 0.14);
  }

  // --- Body -------------------------------------------------------------------------------
  for (const [x, y, w, code] of BODY_RUNS[view][column]) f(x, y, w, 1, codes[code]);

  // --- Face -------------------------------------------------------------------------------
  // Positioned from the head box. Every feature is defined for the baked facing (left, in
  // profile); the `f` helper mirrors it for the other side. The front head is symmetric about
  // its centre column, so its features are too. Up is the back of the head, which has no face.
  if (direction === "down") {
    // Two eyes, 1x2, with a catch-light on the top pixel. Blush and mouth are translucent, so
    // they tint the skin rather than sit on top of it.
    const catchLight = mixHex(AV_INK, "#ffffff", 0.75);
    for (const ex of [4, 8]) {
      f(hx + ex, hy + 6, 1, 1, catchLight);
      f(hx + ex, hy + 7, 1, 1, AV_INK);
    }
    fa(hx + 3, hy + 8, 1, 1, ACCENT.red, 0.28);
    fa(hx + 9, hy + 8, 1, 1, ACCENT.red, 0.28);
    fa(hx + 6, hy + 9, 1, 1, AV_INK, 0.45); // a soft dab, not a moustache
  } else if (facingSide) {
    // One eye, two in from the front outline, where it has skin on both sides to read against.
    f(hx + 2, hy + 5, 1, 1, mixHex(AV_INK, "#ffffff", 0.75));
    f(hx + 2, hy + 6, 1, 1, AV_INK);
    // The nose: a single pixel, one row below the eye, one skin column past the front outline,
    // with its own ink outline. A taller nose read as an ear.
    f(hx - 1, hy + 7, 1, 1, skin.base);
    f(hx - 2, hy + 7, 1, 1, AV_INK);
    f(hx - 1, hy + 6, 1, 1, AV_INK);
    f(hx - 1, hy + 8, 1, 1, AV_INK);
    // The jaw is flat at the front and round only at the back: skin fills the old front outline,
    // and the outline moves out a pixel to meet the nose.
    f(hx + 1, hy + 9, 1, 1, skin.base);
    f(hx, hy + 9, 1, 1, AV_INK);
    f(hx + 2, hy + 10, 1, 1, skin.dark);
    f(hx + 1, hy + 10, 1, 1, AV_INK);
    // Blush just behind and below the eye, and a soft mouth dab at the front of the jaw, drawn
    // over the jaw fill.
    fa(hx + 3, hy + 7, 1, 1, ACCENT.red, 0.28);
    fa(hx + 1, hy + 9, 1, 1, AV_INK, 0.45);
  }

  drawHeadwear();

  // --- Hair, glasses and hats -------------------------------------------------------------
  /**
   * Hair, glasses and hats, painted over the face. Every position is in head-relative art
   * pixels (0,0 is the head box's top-left, so the head's outline runs x 0..12 in the front
   * view), and goes through `f`, so it mirrors and clips with the rest of the sprite.
   *
   * Hair never covers the eye row: the crown stops at the brow, and the sideburns stop at the
   * cheek. Under a hat only the hair that is not on the face shows.
   */
  function drawHeadwear() {
    const hairStyle = avatar?.hairStyle || "short";
    const hatStyle = avatar?.hatStyle || "none";
    const hatted = hatStyle !== "none";
    const hair = rampFrom(safeHex(avatar?.hairColor, "#2b1a10"));
    const pose = direction === "up" ? "back" : facingSide ? "side" : "front";
    const r = (x: number, y: number, w: number, h: number, color: string) =>
      f(hx + x, hy + y, w, h, color);
    const ra = (x: number, y: number, w: number, h: number, color: string, alpha: number) =>
      fa(hx + x, hy + y, w, h, color, alpha);

    /** A non-negative remainder, so the texture tests work for cells above and left of the head. */
    const mod = (n: number, m: number) => ((n % m) + m) % m;

    /**
     * A puff of hair drawn as one shape, such as an afro or curls. `rows` gives the hair's
     * inclusive x spans per row (head-relative). Its outline is every shape cell with a neighbour
     * outside the shape, so the stepped corners and the rounded bottom come out of the spans.
     * `hairline`, if set, is a row of flat hair.dark over the forehead that is not outlined.
     * `texture` colours each interior cell (not the outline or the hairline), and returns null
     * for plain hair.base.
     */
    const puff = (
      rows: Record<number, Array<[number, number]>>,
      hairline: [number, number, number] | null,
      texture: (x: number, y: number) => string | null
    ) => {
      const inShape = (x: number, y: number) =>
        (rows[y] ?? []).some(([l, rr]) => x >= l && x <= rr);
      for (const key of Object.keys(rows)) {
        const y = Number(key);
        for (const [l, rr] of rows[y]) {
          for (let x = l; x <= rr; x++) {
            if (hairline && y === hairline[0] && x >= hairline[1] && x <= hairline[2]) {
              r(x, y, 1, 1, hair.dark);
              continue;
            }
            const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(
              ([dx, dy]) => !inShape(x + dx, y + dy)
            );
            const color = edge ? AV_INK : (texture(x, y) ?? hair.base);
            r(x, y, 1, 1, color);
          }
        }
      }
    };

    // The crown of a haired head, per pose. Short hair starts a px above the skull, with an ink
    // top, and its fringe is broken and sweeps across the brow. Long hair keeps the original
    // crown under its locks, so it is drawn exactly as before.
    const frontCrown = () => {
      if (hairStyle === "long") {
        r(4, 1, 5, 1, hair.base);
        r(4, 1, 2, 1, hair.light);
        r(3, 2, 7, 1, hair.base);
        r(3, 2, 3, 1, hair.light);
        r(4, 2, 2, 1, hair.hi);
        r(2, 3, 9, 2, hair.base);
        r(2, 3, 2, 1, hair.light);
        r(2, 5, 9, 1, hair.base);
        r(2, 5, 1, 2, hair.dark);
        r(10, 6, 1, 1, hair.dark);
        return;
      }
      // Volume: a rounded dome, a px wider than the skull at each side. Row -1 is ink over the top
      // middle only. Each row steps out by a px until the hair meets the skull at row 3.
      r(5, -1, 3, 1, AV_INK);
      r(3, 0, 1, 1, AV_INK);
      r(9, 0, 1, 1, AV_INK);
      r(4, 0, 5, 1, hair.base);
      r(2, 1, 1, 1, AV_INK);
      r(10, 1, 1, 1, AV_INK);
      r(3, 1, 7, 1, hair.base);
      r(1, 2, 1, 1, AV_INK);
      r(11, 2, 1, 1, AV_INK);
      r(2, 2, 9, 1, hair.base);
      // The crown. A light streak runs diagonally down toward the left temple.
      r(4, 1, 2, 1, hair.light);
      r(3, 2, 1, 1, hair.light);
      r(2, 3, 9, 1, hair.base);
      r(2, 3, 1, 1, hair.light);
      r(2, 4, 9, 1, hair.base);
      r(5, 4, 1, 1, hair.dark); // a strand in the mass
      // The side part: a dark line at x8, rows 3-5. The larger side (x2-7) sweeps over it, and its
      // edge steps down from row 5 to row 6 at the temple. The smaller side (x9-10) stays short.
      r(8, 3, 1, 3, hair.dark);
      r(3, 5, 5, 1, hair.base);
      r(6, 5, 1, 1, hair.dark); // a strand in the fringe
      r(9, 5, 2, 1, hair.base);
      r(3, 6, 1, 1, hair.dark);
      r(9, 6, 2, 1, hair.dark);
      // Sideburns, short, over the skull outline at x1-2.
      r(1, 5, 2, 2, hair.dark);
    };
    const sideCrown = () => {
      if (hairStyle === "long") {
        r(3, 1, 5, 1, hair.base);
        r(3, 1, 2, 1, hair.light);
        r(2, 2, 7, 1, hair.base);
        r(2, 2, 2, 1, hair.light);
        r(1, 3, 9, 1, hair.base);
        r(1, 3, 3, 1, hair.light);
        r(1, 4, 3, 1, hair.dark);
        r(4, 4, 3, 1, hair.base);
        r(7, 4, 2, 2, hair.base);
        r(9, 4, 1, 3, hair.dark);
        return;
      }
      // Volume: a rounded dome, a px wider than the skull at the top-back. Row -1 is ink over the
      // top middle only. Each row steps out by a px until the hair meets the skull at row 3.
      r(4, -1, 3, 1, AV_INK);
      r(3, 0, 1, 1, AV_INK);
      r(8, 0, 1, 1, AV_INK);
      r(4, 0, 4, 1, hair.base);
      r(2, 1, 1, 1, AV_INK);
      r(9, 1, 1, 1, AV_INK);
      r(3, 1, 6, 1, hair.base);
      r(1, 2, 1, 1, AV_INK);
      r(10, 2, 1, 1, AV_INK);
      r(2, 2, 8, 1, hair.base);
      // The crown, with a light streak at the top-front.
      r(3, 1, 2, 1, hair.light);
      r(2, 2, 1, 1, hair.light);
      r(1, 3, 9, 1, hair.base);
      // The fringe ends above the eye at row 4, with one dark tip at the front.
      r(2, 4, 8, 1, hair.base);
      r(1, 4, 1, 1, hair.dark);
      // The back of the hair, behind the ear, with a dark underside.
      r(7, 5, 2, 2, hair.base);
      r(9, 5, 1, 2, hair.dark);
      r(7, 7, 3, 1, hair.dark);
      r(8, 8, 1, 1, hair.dark);
    };
    const backCrown = () => {
      if (hairStyle === "long") {
        r(4, 1, 5, 1, hair.base);
        r(4, 1, 2, 1, hair.light);
        r(3, 2, 7, 1, hair.base);
        r(3, 2, 2, 1, hair.hi);
        r(2, 3, 9, 1, hair.base);
        r(1, 4, 11, 4, hair.base);
        r(10, 4, 1, 4, hair.dark);
        r(1, 8, 11, 1, hair.dark);
        return;
      }
      // Volume: a rounded dome, as at the front.
      r(5, -1, 3, 1, AV_INK);
      r(3, 0, 1, 1, AV_INK);
      r(9, 0, 1, 1, AV_INK);
      r(4, 0, 5, 1, hair.base);
      r(2, 1, 1, 1, AV_INK);
      r(10, 1, 1, 1, AV_INK);
      r(3, 1, 7, 1, hair.base);
      r(1, 2, 1, 1, AV_INK);
      r(11, 2, 1, 1, AV_INK);
      r(2, 2, 9, 1, hair.base);
      // The crown, with a light streak on the top-left.
      r(4, 1, 2, 1, hair.light);
      r(3, 2, 1, 1, hair.light);
      r(2, 3, 9, 1, hair.base);
      r(2, 3, 1, 1, hair.light);
      // The back of the skull, down to row 8, with a dark shade on its right-hand edge.
      r(2, 4, 9, 2, hair.base);
      r(1, 6, 11, 3, hair.base);
      r(10, 4, 1, 4, hair.dark);
      // Two short strands in the lower half, to break up the mass.
      r(4, 5, 1, 3, hair.dark);
      r(8, 6, 1, 2, hair.dark);
      // A ragged bottom edge at row 9, with two tips dipping to row 10 over the nape.
      r(3, 9, 7, 1, hair.dark);
      r(4, 10, 1, 1, hair.dark);
      r(8, 10, 1, 1, hair.dark);
    };
    /**
     * Curly: a tight puff with a scalloped top, three bumps across the crown, drawn in place of
     * the crown. Row -1 of interior cells is lit, so each bump reads as a lit curl, and the rest
     * of the mass has a sparse light and dark lattice.
     */
    const curlyPuff = () => {
      const curlyTexture = (x: number, y: number) => {
        if (y === -1) return hair.light;
        if (mod(x + 2 * y, 5) === 0 && x + y <= 5) return hair.light;
        if (mod(x + 2 * y, 5) === 3 && x + y >= 11) return hair.dark;
        return null;
      };
      if (pose === "side") {
        puff(
          {
            [-2]: [[1, 2], [4, 5], [7, 8]],
            [-1]: [[0, 9]],
            0: [[-1, 10]],
            1: [[-1, 11]],
            2: [[-1, 11]],
            3: [[-1, 11]],
            4: [[1, 11]],
            5: [[6, 11]],
            6: [[7, 10]],
          },
          [4, 1, 5],
          curlyTexture
        );
      } else if (pose === "back") {
        puff(
          {
            [-2]: [[2, 3], [5, 7], [9, 10]],
            [-1]: [[1, 11]],
            0: [[0, 12]],
            1: [[-1, 13]],
            2: [[-1, 13]],
            3: [[-1, 13]],
            4: [[-1, 13]],
            5: [[0, 12]],
            6: [[0, 12]],
            7: [[0, 12]],
            8: [[1, 11]],
          },
          null,
          curlyTexture
        );
      } else {
        puff(
          {
            [-2]: [[2, 3], [5, 7], [9, 10]],
            [-1]: [[1, 11]],
            0: [[0, 12]],
            1: [[-1, 13]],
            2: [[-1, 13]],
            3: [[-1, 13]],
            4: [[-1, 13]],
            5: [[-1, 1], [11, 13]],
            6: [[-1, 0], [12, 13]],
          },
          [4, 2, 10],
          curlyTexture
        );
      }
    };

    if (hairStyle === "bald") {
      // Nothing extra: the baked skin shows the scalp.
    } else if (!hatted && hairStyle === "afro") {
      // Round mass from the brow up: 2-3px past the skull each side, rising 4px above the
      // skull top (it fits in PAD_TOP). The front edge stops at the temples, clear of the eyes.
      // In profile it bulges backwards, with its front edge just behind the forehead.
      // Front: the puff ends at the temples, with the hairline a flat row over the forehead.
      // Back: the middle runs on down the whole skull, to y 8, with no face to leave clear.
      // Side: the puff's front edge is flush with the forehead, and it reaches 3-4px past the
      // back of the skull.
      const afroTexture = (x: number, y: number) => {
        if ((x === 2 && y === -3) || (x === 1 && y === -2)) return hair.hi;
        if (mod(x + 2 * y, 5) === 0 && x + y <= 3) return hair.light;
        if (mod(x + 2 * y, 5) === 3 && x + y >= 12) return hair.dark;
        return null;
      };
      const top: Record<number, Array<[number, number]>> = {
        [-4]: [[3, 9]],
        [-3]: [[1, 11]],
        [-2]: [[0, 12]],
        [-1]: [[-1, 13]],
        0: [[-2, 14]],
        1: [[-2, 14]],
        2: [[-2, 14]],
        3: [[-3, 15]],
      };
      if (pose === "side") {
        puff(
          {
            [-4]: [[5, 8]],
            [-3]: [[3, 10]],
            [-2]: [[2, 11]],
            [-1]: [[1, 12]],
            0: [[0, 13]],
            1: [[0, 13]],
            2: [[0, 13]],
            3: [[0, 14]],
            4: [[1, 14]],
            5: [[4, 13]],
            6: [[5, 12]],
          },
          [4, 1, 3],
          afroTexture
        );
      } else if (pose === "back") {
        puff(
          {
            ...top,
            4: [[-3, 15]],
            5: [[-2, 14]],
            6: [[-1, 13]],
            7: [[0, 12]],
            8: [[0, 12]],
          },
          null,
          afroTexture
        );
      } else {
        puff(
          {
            ...top,
            4: [[-3, 15]],
            5: [[-2, 1], [11, 14]],
            6: [[-1, 0], [12, 13]],
          },
          [4, 2, 10],
          afroTexture
        );
      }
    } else if (!hatted && hairStyle === "curly") {
      // Curly hair replaces the crown: the puff covers the top of the head and the sides.
      curlyPuff();
    } else if (!hatted) {
      if (pose === "side") sideCrown();
      else if (pose === "back") backCrown();
      else frontCrown();

      if (hairStyle === "long") {
        if (pose === "front") {
          // Two locks that hug and frame the face, overlaying the head's side outline. Each is an
          // inked outer edge with 2px of hair beside it. The inner column sits in shadow next to
          // the face, each lock is lit at its top, and the tip is inked and rounded.
          for (let y = 3; y <= 14; y++) {
            r(-1, y, 1, 1, AV_INK);
            r(0, y, 2, 1, hair.base);
            r(13, y, 1, 1, AV_INK);
            r(11, y, 2, 1, hair.base);
          }
          for (let y = 6; y <= 14; y++) {
            r(1, y, 1, 1, hair.dark);
            r(11, y, 1, 1, hair.dark);
          }
          r(0, 2, 2, 1, AV_INK);
          r(11, 2, 2, 1, AV_INK);
          r(0, 3, 1, 1, hair.light);
          r(12, 3, 1, 1, hair.light);
          r(0, 15, 2, 1, AV_INK);
          r(11, 15, 2, 1, AV_INK);
          r(0, 14, 1, 1, hair.dark);
          r(12, 14, 1, 1, hair.dark);
        } else if (pose === "back") {
          // From behind the hair is one mass: it covers the back of the skull, runs on over the
          // nape and the shoulders, and ends in a rounded tip about 3-4 rows below them.
          for (let y = 9; y <= 14; y++) {
            r(2, y, 9, 1, hair.base);
            r(10, y, 1, 1, hair.dark);
          }
          r(2, 9, 1, 3, hair.light);
          r(3, 15, 7, 1, hair.base); // narrower at the tip
          r(3, 15, 1, 1, hair.light);
          r(9, 15, 1, 1, hair.dark);
          r(4, 16, 5, 1, hair.dark); // rounded corners: the tip row is inset on both sides
        } else {
          // In profile one lock falls behind the head from the ear row to the shoulder. Its inner
          // column sits on the back outline of each row (replacing that outline pixel), so it
          // touches the skull with no gap, and only its outer edge is inked.
          const sideIdle = BODY_FRAMES.side[IDLE_COLUMN];
          for (let y = 5; y <= 14; y++) {
            const back = sideIdle.rows[y + sideIdle.headBox.y].lastIndexOf("o") - sideIdle.headBox.x;
            r(back, y, 1, 1, hair.base);
            r(back + 1, y, 1, 1, hair.base);
            r(back + 2, y, 1, 1, AV_INK);
          }
          r(10, 5, 1, 1, hair.light);
          r(10, 15, 2, 1, hair.dark);
        }
      }
    } else {
      // Under a hat only the hair off the face shows: the sideburns from the front, the back of
      // the head from behind or in profile. Never a band across the eyes.
      if (pose === "front") {
        r(2, 5, 1, 2, hair.dark);
        r(10, 5, 1, 2, hair.dark);
      } else if (pose === "side") {
        // A small patch at the back edge, under the cap, rounded at the bottom.
        r(8, 5, 2, 2, hair.base);
        r(8, 7, 1, 1, hair.base);
        r(9, 7, 1, 1, hair.dark);
      } else {
        r(2, 5, 9, 2, hair.base); // just below the hat's band, above the nape
        r(2, 6, 9, 1, hair.dark);
      }
    }

    // Glasses: translucent lenses so the eye still reads through them, over the hair.
    if (avatar?.glasses && pose !== "back") {
      if (pose === "side") {
        // A lens frame 3 wide and 4 tall around the eye, and one arm: a single ink row that runs
        // back from the frame's top row, leaving a 1px gap to the frame.
        ra(2, 5, 1, 2, ACCENT.sky, 0.4);
        r(1, 4, 3, 1, AV_INK);
        r(1, 7, 3, 1, AV_INK);
        r(1, 5, 1, 2, AV_INK);
        r(3, 5, 1, 2, AV_INK);
        r(4, 4, 2, 1, AV_INK);
      } else {
        // Two lens frames, 3 wide, around the eyes, joined by a one-pixel bridge.
        [4, 8].forEach((ex) => {
          ra(ex, 6, 1, 2, ACCENT.sky, 0.4);
          r(ex - 1, 5, 3, 1, AV_INK);
          r(ex - 1, 8, 3, 1, AV_INK);
          r(ex - 1, 6, 1, 2, AV_INK);
          r(ex + 1, 6, 1, 2, AV_INK);
        });
        r(6, 6, 1, 1, AV_INK);
      }
    }

    /**
     * The outlined crown of a hat, for the current pose. Row -1 is the ink along the top, and
     * each row below steps out to the skull's outline until the sides run straight down to row 4.
     * The crown is shaded from the top-left, with a hi pixel on the highlight and a dark column
     * down the right-hand edge in shadow.
     */
    const dome = (ramp: Ramp) => {
      // Per row: the ink columns at each side, then the span of fill between them.
      const rows: Array<[inkL: number, inkR: number, fillL: number, fillR: number]> =
        pose === "side"
          ? [
              [2, 8, 3, 7],
              [1, 9, 2, 8],
              [0, 10, 1, 9],
              [0, 10, 1, 9],
              [0, 10, 1, 9],
            ]
          : [
              [3, 9, 4, 8],
              [2, 10, 3, 9],
              [1, 11, 2, 10],
              [1, 11, 2, 10],
              [1, 11, 2, 10],
            ];
      const top = pose === "side" ? [3, 7] : [4, 8];
      const light =
        pose === "side"
          ? [[3, 0], [4, 0], [2, 1], [3, 1], [1, 2]]
          : [[4, 0], [5, 0], [3, 1], [4, 1], [2, 2]];
      const dark =
        pose === "side"
          ? [[7, 0], [8, 1], [9, 2], [9, 3], [9, 4]]
          : [[8, 0], [9, 1], [10, 2], [10, 3], [10, 4]];
      const hi = pose === "side" ? [3, 0] : [4, 0];

      r(top[0], -1, top[1] - top[0] + 1, 1, AV_INK);
      rows.forEach(([inkL, inkR, fillL, fillR], y) => {
        r(inkL, y, 1, 1, AV_INK);
        r(inkR, y, 1, 1, AV_INK);
        r(fillL, y, fillR - fillL + 1, 1, ramp.base);
      });
      for (const [x, y] of light) r(x, y, 1, 1, ramp.light);
      for (const [x, y] of dark) r(x, y, 1, 1, ramp.dark);
      r(hi[0], hi[1], 1, 1, ramp.hi);
    };

    // Hats: a crown over the top of the head, with a brim or peak and a band.
    if (hatStyle === "cap") {
      const cap = rampFrom(ACCENT.red);
      dome(cap);
      // The band runs round the head just above the brow, from outline to outline.
      const [bandL, bandR] = pose === "side" ? [1, 9] : [2, 10];
      r(bandL, 4, bandR - bandL + 1, 1, cap.dark);
      if (pose === "side") {
        // Peak: juts three pixels past the front of the face, with its own outline.
        r(-3, 2, 3, 1, AV_INK);
        r(-3, 3, 3, 1, cap.base);
        r(-3, 4, 3, 1, cap.dark);
        r(-3, 5, 3, 1, AV_INK);
        r(-4, 3, 1, 2, AV_INK);
      } else if (pose === "back") {
        // The bottom edge of the cap, with a light snapback buckle in the band.
        r(1, 5, 11, 1, AV_INK);
        r(6, 4, 1, 1, cap.light);
      } else {
        // The peak points at the viewer: a lit band one pixel wider than the skull on each side,
        // and a soft shadow on the face just below it.
        r(0, 5, 1, 1, AV_INK);
        r(12, 5, 1, 1, AV_INK);
        r(1, 5, 11, 1, cap.light);
        ra(2, 6, 9, 1, AV_INK, 0.3);
      }
    } else if (hatStyle === "beanie") {
      const beanie = rampFrom(ACCENT.teal);
      dome(beanie);
      // A ribbed folded band: the fill alternates between two tones, column by column.
      const [bandL, bandR] = pose === "side" ? [1, 9] : [2, 10];
      for (let x = bandL; x <= bandR; x++) {
        r(x, 4, 1, 1, x % 2 === 0 ? beanie.hi : beanie.light);
      }
      // The bottom edge of the band, outlined across its width and the outline columns.
      const [edgeL, edgeR] = pose === "side" ? [0, 10] : [1, 11];
      r(edgeL, 5, edgeR - edgeL + 1, 1, AV_INK);
      // A 2x2 yellow pom sitting on the dome's top ink, outlined on its sides and top.
      const [pomL, pomR] = pose === "side" ? [3, 6] : [4, 7];
      r(pomL + 1, -4, 2, 1, AV_INK);
      r(pomL, -3, 1, 2, AV_INK);
      r(pomR, -3, 1, 2, AV_INK);
      r(pomL + 1, -3, 2, 2, ACCENT.yellow);
      // The lit top-left pixel of the pom, lightened so it reads as a rounded puff.
      r(pomL + 1, -3, 1, 1, mixHex(ACCENT.yellow, "#ffffff", 0.4));
    }
  }

  // --- Presence pip -----------------------------------------------------------------------
  // Anchored to the current frame's head, so it bobs with it. Never mirrored: it is UI, not
  // part of the character. Overlapping the head's corner rather than floating clear of it -
  // detached, it read as an unrelated coloured box hovering beside the character.
  const headL = PAD_X + hb.x;
  const headR = headL + hb.w;
  const headTop = PAD_TOP + hb.y;
  // Screen-space edges: a mirrored head's front and back swap sides.
  const screenLeft = mirror ? AV_W - headR : headL;
  const screenRight = mirror ? AV_W - headL : headR;

  if (presence) {
    const color = PRESENCE_COLORS[presence] || PRESENCE_COLORS.available;
    ctx.fillStyle = AV_INK;
    ctx.fillRect(ox + (screenRight - 3) * scale, oy + headTop * scale, 4 * scale, 4 * scale);
    ctx.fillStyle = color;
    ctx.fillRect(
      ox + (screenRight - 2) * scale,
      oy + (headTop + 1) * scale,
      2 * scale,
      2 * scale
    );
  }

  // --- Status emoji chip ------------------------------------------------------------------
  // Tucked against the head's opposite corner, deliberately outside the body: any larger or
  // further in and it sits squarely on the torso, hiding the outfit and one whole arm.
  if (showEmoji) {
    const size = 4 * scale;
    const bx = ox + (screenLeft - 3) * scale;
    const by = oy + headTop * scale;
    ctx.fillStyle = AV_INK;
    ctx.fillRect(bx - 2, by - 2, size + 4, size + 4);
    ctx.fillStyle = ACCENT.yellow;
    ctx.fillRect(bx, by, size, size);
    ctx.font = `${Math.round(size * 0.85)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(avatar?.statusEmoji || '👋', bx + size / 2, by + size / 2 + 1);
  }
}
