import type { AvatarCustomization, Direction, PresenceStatus } from '../types';
import { ACCENT, mixHex, rampFrom, safeHex, SHADOW_TINT, type Ramp } from './pixelArt';

/**
 * The character sprite, in one place.
 *
 * Both the world canvas (SpatialCanvas) and the Avatar Studio preview (AvatarBuilder) draw
 * through this function. They previously each had their own idea of what an avatar looked
 * like - one canvas, one HTML/CSS - which meant every change to the character had to be
 * made twice and the two drifted apart until the Studio was showing something the map never
 * rendered. A single scale-parameterised draw makes that drift impossible.
 *
 * 16x18 art pixels: at the map's 3px art pixel that is 48x54, so a character stands about
 * one tile tall and comfortably under a tile wide. Proportions stay chibi - a 10x7 head
 * over an 8-wide torso - because the head carries every piece of identity (skin, hair,
 * glasses, hat) and equal-width head and body read as two stacked rectangles at this size.
 *
 * The art-pixel size is deliberately the same as the tiles' and furniture's. Rendering the
 * character at a smaller art pixel to shrink it would make it the one part of the scene
 * drawn on a finer grid, which reads as a sprite from a different game.
 */

export const AV_W = 16;
export const AV_H = 18;
export const AV_INK = "#1e293b";

// Sprite rows, top to bottom. Named because every feature is positioned relative to them.
const HEAD_X = 3;
const HEAD_W = 10;
const HEAD_Y = 2;
const HEAD_H = 7;
const CROWN_Y = 1; // hair/hat sits one row proud of the skull, giving it volume
const TORSO_Y = 10;
const TORSO_H = 4;
const ARM_Y = 11;
const ARM_H = 3;
const LEG_Y = 14;
const LEG_H = 3;

export interface AvatarSpriteOptions {
  /** Which way the character faces. Defaults to 'down' (toward the camera). */
  direction?: Direction;
  /** Walk cycle frame 0-3, or -1 to stand still. See the walk notes below. */
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
  const { direction = "down", walkPhase = -1, presence = null, showEmoji = false } = options;

  // --- Walk cycle -------------------------------------------------------------
  // Four frames: two contact poses (one leg striding) separated by two passing poses where
  // the feet are together. On the passing frames the whole body rises exactly one art
  // pixel, which is what gives a walk its gait; the arms swing opposite the striding leg.
  //
  // The lift is a whole art pixel rather than the smooth sine bounce this used to have.
  // That bounce moved the body by fractional pixels, and since the sprite origin has to be
  // rounded to stay crisp, it showed up as an irregular 1-2px jitter instead of a bounce.
  const walking = walkPhase >= 0;
  const strideLeft = walking && walkPhase === 0;
  const strideRight = walking && walkPhase === 2;
  const passing = walking && (walkPhase === 1 || walkPhase === 3);
  if (passing) oy -= scale;

  const skin = rampFrom(safeHex(avatar?.skinColor, "#f0b090"));
  const hair = rampFrom(safeHex(avatar?.hairColor, "#2b1a10"));
  const outfit = rampFrom(safeHex(avatar?.outfitColor, "#5b86cf"));
  const trouser = rampFrom(mixHex(outfit.base, SHADOW_TINT, 0.42));
  const shoe = mixHex(outfit.base, AV_INK, 0.65);

  const hairStyle = avatar?.hairStyle || "short";
  const hatStyle = avatar?.hatStyle || "none";
  const hatted = hatStyle !== "none";
  const facingUp = direction === "up";
  const facingSide = direction === "left" || direction === "right";
  const mirror = direction === "left";

  /** Fill art pixels, mirrored horizontally when the character faces left. */
  const f = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(ox + (mirror ? AV_W - x - w : x) * scale, oy + y * scale, w * scale, h * scale);
  };
  /** Translucent variant, for blush and glass. */
  const fa = (x: number, y: number, w: number, h: number, color: string, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    f(x, y, w, h, color);
    ctx.restore();
  };
  /** Cel shading only: light on the top/left, shade on the bottom/right. */
  const shade = (x: number, y: number, w: number, h: number, ramp: Ramp) => {
    f(x, y, w, h, ramp.base);
    f(x, y, w, 1, ramp.light);
    f(x, y, 1, h, ramp.light);
    f(x + w - 1, y, 1, h, ramp.dark);
    f(x, y + h - 1, w, 1, ramp.dark);
  };
  /** A shaded block with precise 1px perimeter outline (no solid filled dark background box). */
  const part = (x: number, y: number, w: number, h: number, ramp: Ramp) => {
    f(x - 1, y - 1, w + 2, 1, AV_INK);
    f(x - 1, y + h, w + 2, 1, AV_INK);
    f(x - 1, y, 1, h, AV_INK);
    f(x + w, y, 1, h, AV_INK);
    shade(x, y, w, h, ramp);
  };

  // --- Afro halo, drawn behind the head ---------------------------------------
  if (!hatted && hairStyle === "afro") {
    f(1, 0, 14, 1, AV_INK);
    f(1, 8, 14, 1, AV_INK);
    f(1, 0, 1, 9, AV_INK);
    f(14, 0, 1, 9, AV_INK);
    f(2, 0, 12, 8, hair.base);
    f(3, 0, 10, 1, hair.light);
    f(2, 7, 12, 1, hair.dark);
  }

  // --- Legs -------------------------------------------------------------------
  const legs: Array<[number, number]> = [
    [4, strideLeft ? 1 : 0],
    [9, strideRight ? 1 : 0],
  ];
  legs.forEach(([lx, lift]) => {
    const h = LEG_H - lift;
    f(lx - 1, LEG_Y + lift, 1, h + 1, AV_INK);
    f(lx + 3, LEG_Y + lift, 1, h + 1, AV_INK);
    f(lx, LEG_Y + lift + h, 3, 1, AV_INK);
    f(lx, LEG_Y + lift, 3, h, trouser.base);
    f(lx, LEG_Y + lift, 1, h, trouser.light);
    f(lx, LEG_Y + lift + h - 1, 3, 1, shoe);
  });

  // --- Torso and arms ---------------------------------------------------------
  const armLeftY = ARM_Y - (strideRight ? 1 : 0);
  const armRightY = ARM_Y - (strideLeft ? 1 : 0);

  // Precise tight outline matching torso & arm silhouette
  f(1, armLeftY, 1, ARM_H, AV_INK);
  f(2, armLeftY + ARM_H, 2, 1, AV_INK);
  f(14, armRightY, 1, ARM_H, AV_INK);
  f(12, armRightY + ARM_H, 2, 1, AV_INK);
  f(4, TORSO_Y + TORSO_H, 8, 1, AV_INK);
  f(3, TORSO_Y - 1, 10, 1, AV_INK);

  shade(2, armLeftY, 2, ARM_H, outfit);
  shade(12, armRightY, 2, ARM_H, outfit);
  shade(4, TORSO_Y, 8, TORSO_H, outfit);
  f(2, armLeftY + ARM_H - 1, 2, 1, skin.base); // hands
  f(12, armRightY + ARM_H - 1, 2, 1, skin.base);
  if (!facingUp) {
    f(6, TORSO_Y, 4, 1, skin.dark); // neckline
    f(6, TORSO_Y + 1, 4, 1, outfit.hi); // collar
  }

  // --- Head -------------------------------------------------------------------
  part(HEAD_X, HEAD_Y, HEAD_W, HEAD_H, skin);
  // Ears: one each side facing the camera, only the back one in profile.
  if (!facingSide) {
    f(2, 5, 1, 2, skin.base);
    f(2, 6, 1, 1, skin.dark);
    f(13, 5, 1, 2, skin.dark);
  } else {
    f(5, 5, 1, 2, skin.dark);
  }

  // --- Hair over the head -----------------------------------------------------
  if (!hatted && hairStyle !== 'bald') {
    // Facing away, the back of the head is all hair - the single strongest cue that a
    // character has turned around. Facing the camera it is a real mass with volume, not
    // the thin band across the forehead that a 2px crown reads as.
    const crownH = facingUp ? HEAD_H + 1 : 4;
    f(2, CROWN_Y - 1, 12, 1, AV_INK);
    f(2, CROWN_Y, 1, crownH, AV_INK);
    f(13, CROWN_Y, 1, crownH, AV_INK);
    f(HEAD_X, CROWN_Y, HEAD_W, crownH, hair.base);
    f(HEAD_X, CROWN_Y, HEAD_W, 1, hair.light);
    f(HEAD_X, CROWN_Y + crownH - 1, HEAD_W, 1, hair.dark);

    if (hairStyle === 'curly') {
      [3, 6, 9].forEach((bx) => f(bx, CROWN_Y - 1, 2, 1, hair.light)); // bumpy silhouette
      f(HEAD_X, 5, 1, 2, hair.base);
      f(HEAD_X + HEAD_W - 1, 5, 1, 2, hair.base);
    } else if (hairStyle === 'short') {
      f(HEAD_X, 5, 1, 2, hair.dark); // sideburns
      f(HEAD_X + HEAD_W - 1, 5, 1, 2, hair.dark);
    } else if (hairStyle === 'long') {
      // Locks hanging in front of the shoulders, so they read over the outfit.
      ([
        [1, 0],
        [13, 15],
      ] as Array<[number, number]>).forEach(([lx, inkX]) => {
        f(inkX, 5, 1, 8, AV_INK);
        f(lx, 13, 2, 1, AV_INK);
        f(lx, 5, 2, 8, hair.base);
        f(lx, 5, 2, 1, hair.light);
        f(lx, 12, 2, 1, hair.dark);
      });
    }
    if (facingSide && hairStyle !== 'curly') f(4, 5, 2, 1, hair.dark); // fringe sweep
  } else if (!hatted && hairStyle === 'bald') {
    f(5, HEAD_Y, 4, 1, skin.hi); // scalp catch-light
  }

  // --- Face -------------------------------------------------------------------
  if (!facingUp) {
    // Sits clear of the head's bottom row, which the cel shading already darkens - a mouth
    // drawn onto that row merged with it into what read as a beard.
    const eyes: Array<[number, number]> = facingSide
      ? [[8, 5]]
      : [
          [5, 5],
          [9, 5],
        ];
    eyes.forEach(([ex, ey]) => {
      f(ex, ey, 2, 2, AV_INK);
      f(ex, ey, 1, 1, mixHex(AV_INK, '#ffffff', 0.75)); // catch-light
    });

    // Blush and mouth, translucent so they tint the skin rather than sit on top of it.
    // Drawn before the glasses so a frame simply covers anything it overlaps.
    fa(4, 7, 2, 1, ACCENT.red, 0.28);
    fa(10, 7, 2, 1, ACCENT.red, 0.28);
    // Full-strength ink across two pixels read as a moustache; this is a soft dab.
    fa(facingSide ? 9 : 7, 7, 2, 1, AV_INK, 0.45);
    if (facingSide) f(13, 6, 1, 1, skin.light); // nose in profile

    if (avatar?.glasses) {
      // Translucent lenses so the eyes still read through them.
      const lenses = facingSide ? [7] : [4, 9];
      lenses.forEach((lx) => {
        fa(lx, 5, 3, 2, ACCENT.sky, 0.4);
        f(lx, 4, 3, 1, AV_INK);
        f(lx, 7, 3, 1, AV_INK);
        f(lx, 5, 1, 2, AV_INK);
        f(lx + 2, 5, 1, 2, AV_INK);
      });
      if (!facingSide) f(7, 6, 2, 1, AV_INK); // bridge
    }
  }

  // --- Headwear ---------------------------------------------------------------
  if (hatStyle === 'cap') {
    const cap = rampFrom(ACCENT.red);
    part(HEAD_X, CROWN_Y, HEAD_W, 4, cap);
    // The peak follows the direction of travel, which sells the facing at this size more
    // than the face itself does.
    if (facingUp) f(HEAD_X, CROWN_Y - 1, HEAD_W, 1, cap.dark);
    else if (facingSide) f(13, 4, 3, 1, cap.dark);
    else f(2, 5, 12, 1, cap.dark);
  } else if (hatStyle === 'beanie') {
    const beanie = rampFrom(ACCENT.teal);
    part(HEAD_X, CROWN_Y, HEAD_W, 4, beanie);
    f(HEAD_X, CROWN_Y + 3, HEAD_W, 1, beanie.hi); // folded band
    f(7, CROWN_Y - 2, 2, 2, AV_INK);
    f(7, CROWN_Y - 2, 2, 1, ACCENT.yellow); // pom
  }

  // --- Presence pip -----------------------------------------------------------
  // Never mirrored: it is UI, not part of the character. Overlapping the head's corner
  // rather than floating clear of it - detached, it read as an unrelated coloured box
  // hovering beside the character.
  if (presence) {
    const color = PRESENCE_COLORS[presence] || PRESENCE_COLORS.available;
    ctx.fillStyle = AV_INK;
    ctx.fillRect(ox + 11 * scale, oy + 1 * scale, 4 * scale, 4 * scale);
    ctx.fillStyle = color;
    ctx.fillRect(ox + 12 * scale, oy + 2 * scale, 2 * scale, 2 * scale);
  }

  // --- Status emoji chip ------------------------------------------------------
  // Tucked against the head's opposite corner, deliberately outside the body: any larger
  // or further in and it sits squarely on the torso, hiding the outfit and one whole arm.
  if (showEmoji) {
    const size = 4 * scale;
    const bx = ox - scale;
    const by = oy + 1 * scale;
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
