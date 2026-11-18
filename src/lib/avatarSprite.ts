import type { AvatarCustomization, Direction, PresenceStatus } from '../types';
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
 * 16x18 art pixels: at the map's 3px art pixel that is 48x54, so a character stands about
 * one tile tall and comfortably under a tile wide. Proportions stay chibi - a 10x7 head
 * over an 8-wide torso - because the head carries every piece of identity (skin, hair,
 * glasses, hat) and equal-width head and body read as two stacked rectangles at this size.
 *
 * The art-pixel size is deliberately the same as the tiles' and furniture's. Rendering the
 * character at a smaller art pixel to shrink it would make it the one part of the scene
 * drawn on a finer grid, which reads as a sprite from a different game.
 *
 * Three views are painted, not one symmetric figure with conditionals bolted on: the front
 * (facing the camera), the back, and the profile (left/right, which is the front view's
 * geometry mirrored by the `f` helper only for 'left'). Each view has its own head, body and
 * legs, because a profile is not a front view with the face moved - it has one eye, one arm
 * and legs that stride rather than stand side by side.
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

/**
 * The head block, in art pixels, for karts: everything from the hat peak / pom down to the
 * skull's bottom outline, and out to the long-hair locks. Half-open: x in [x0, x1), y in
 * [y0, y1). The front and back views are symmetric about the centre column, so mirroring
 * keeps them in place; the profile is not, so its nose and back of head are placed so that
 * the block's painted extent still mirrors cleanly (leftmost x + rightmost x = AV_W).
 */
const HEAD_CLIP = { x0: 1, x1: 15, y0: -1, y1: 10 };
/** Size in art pixels of the head block drawn by {@link drawAvatarHead}. */
export const AVATAR_HEAD_SIZE = {
  w: HEAD_CLIP.x1 - HEAD_CLIP.x0,
  h: HEAD_CLIP.y1 - HEAD_CLIP.y0,
};

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
  paintAvatar(ctx, ox, oy, scale, avatar, options, false);
}

/**
 * Draws only the head (hair, face, ears, hat) of the character, for a kart driver whose
 * head shows above the seat. Same palette and rows as {@link drawAvatarSprite}; no torso,
 * arms, legs, shadow, presence pip or status chip.
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
  // The ground is captured before the passing-frame lift. The shadow is drawn from it, so
  // the body bounces off the floor while the shadow stays where the feet are.
  const groundY = oy;
  if (passing) oy -= scale;

  const skin = rampFrom(safeHex(avatar?.skinColor, "#f0b090"));
  const hair = rampFrom(safeHex(avatar?.hairColor, "#2b1a10"));
  const outfit = rampFrom(safeHex(avatar?.outfitColor, "#5b86cf"));
  const trouser = rampFrom(mixHex(outfit.base, SHADOW_TINT, 0.42));
  // The far leg in profile sits behind the near one, so it is one step darker still.
  // The far leg is the trouser's dark tone, so the near leg reads as the one in front.
  const trouserFar = rampFrom(trouser.dark);
  const shoe = mixHex(outfit.base, AV_INK, 0.65);
  // A lighter toe on each shoe, so the foot reads as a shoe rather than a stub of colour.
  const shoeLight = mixHex(shoe, LIGHT_TINT, 0.35);

  const hairStyle = avatar?.hairStyle || "short";
  const hatStyle = avatar?.hatStyle || "none";
  const hatted = hatStyle !== "none";
  const facingUp = direction === "up";
  const facingSide = direction === "left" || direction === "right";
  const mirror = direction === "left";
  // Profile only: +1 when the near leg is forward (the arm on that side swings back).
  const near = facingSide ? (strideLeft ? 1 : strideRight ? -1 : 0) : 0;

  /** Fill art pixels, mirrored horizontally when the character faces left. */
  const f = (x: number, y: number, w: number, h: number, color: string) => {
    let ax = mirror ? AV_W - x - w : x;
    let ay = y;
    let aw = w;
    let ah = h;
    if (clip) {
      // Head-only: trim to the head block, so anything hanging out of it (the beanie pom,
      // long locks) is cut at the block edge rather than painted outside the head.
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
  /**
   * Like {@link part}, but the outline's four corner pixels are left out and the block's own
   * corner pixels are inked. The silhouette then steps in at each corner instead of meeting
   * at a right angle: a skull or a shoulder reads as round rather than as a box.
   */
  const roundedPart = (x: number, y: number, w: number, h: number, ramp: Ramp) => {
    f(x, y - 1, w, 1, AV_INK);
    f(x, y + h, w, 1, AV_INK);
    f(x - 1, y, 1, h, AV_INK);
    f(x + w, y, 1, h, AV_INK);
    shade(x, y, w, h, ramp);
    f(x, y, 1, 1, AV_INK);
    f(x + w - 1, y, 1, 1, AV_INK);
    f(x, y + h - 1, 1, 1, AV_INK);
    f(x + w - 1, y + h - 1, 1, 1, AV_INK);
  };
  /**
   * One profile leg: a 2px column, lit on its back edge, with a shoe row whose lighter toe is
   * the front pixel. The near leg gets an outline on both edges; the far leg is hidden behind
   * it at the front, so it only gets its back outline. Without the inner outlines the two legs
   * read as dark vertical stripes rather than two legs.
   */
  const sideLeg = (fx: number, ramp: Ramp, sole: string, frontOutline: boolean) => {
    f(fx - 1, LEG_Y, 1, LEG_H + 1, AV_INK);
    if (frontOutline) f(fx + 2, LEG_Y, 1, LEG_H + 1, AV_INK);
    f(fx, LEG_Y + LEG_H, 2, 1, AV_INK);
    f(fx, LEG_Y, 2, LEG_H, ramp.base);
    f(fx, LEG_Y, 1, LEG_H, ramp.light);
    f(fx, LEG_Y + LEG_H - 1, 2, 1, sole);
    f(fx + 1, LEG_Y + LEG_H - 1, 1, 1, shoeLight); // toe, on the facing side
  };

  // --- Ground shadow ----------------------------------------------------------
  // A translucent 10x2 patch under the feet, drawn first so everything sits on top of it.
  // Its ends are at half strength so the edge fades instead of ending in a hard step. It is
  // placed from the ground line, not the lifted origin, so it does not bob with the walk.
  // Skipped in head-only mode: a kart's head has no feet to stand on.
  if (!headOnly) {
    const shadow = (x: number, w: number, alpha: number) => {
      ctx.fillStyle = `rgba(20, 26, 44, ${alpha})`;
      ctx.fillRect(ox + x * scale, groundY + 17 * scale, w * scale, 2 * scale);
    };
    shadow(4, 8, 0.28);
    shadow(3, 1, 0.14);
    shadow(12, 1, 0.14);
  }

  // --- Afro halo, drawn behind the head (front and back only) -----------------
  // In profile the afro is drawn as part of the head instead, so it has a back and a face.
  if (!hatted && hairStyle === "afro" && !facingSide) {
    f(1, 0, 14, 1, AV_INK);
    f(1, 8, 14, 1, AV_INK);
    f(1, 0, 1, 9, AV_INK);
    f(14, 0, 1, 9, AV_INK);
    f(2, 0, 12, 8, hair.base);
    f(3, 0, 10, 1, hair.light);
    f(2, 7, 12, 1, hair.dark);
  }

  // --- Legs -------------------------------------------------------------------
  if (!headOnly) {
    if (facingSide) {
      // Profile: the legs stride front and back. The far leg is behind (darker, drawn first),
      // the near leg in front, and they move in opposite directions on the contact frames.
      sideLeg(5 - near, trouserFar, shoe, false);
      sideLeg(7 + near, trouser, shoe, true);
    } else {
      // Front and back: side by side, the striding leg lifts one row.
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
        f(lx, LEG_Y + lift + h - 1, 1, 1, shoeLight); // toe
      });
    }
  }

  // --- Torso and arms ---------------------------------------------------------
  const armLeftY = ARM_Y - (strideRight ? 1 : 0);
  const armRightY = ARM_Y - (strideLeft ? 1 : 0);

  if (!headOnly) {
    if (facingSide) {
      // Profile torso: six wide, its shoulder corners rounded like the head's.
      roundedPart(5, TORSO_Y, 6, TORSO_H, outfit);
      f(5, TORSO_Y + TORSO_H - 1, 6, 1, trouser.dark); // belt, between torso and legs
      // One arm, the near one. It swings opposite the near leg: back when the leg is forward.
      const armX = 7 - near;
      part(armX, ARM_Y, 2, ARM_H, outfit);
      f(armX, ARM_Y + ARM_H - 1, 2, 1, skin.base); // hand
    } else {
      // From behind with long hair, the hair falls over the shoulders and the arms sit behind
      // it: drawing them would leave stray hands and outfit pixels at the hair's bottom corners.
      const armsHidden = facingUp && hairStyle === 'long';
      // Front and back torso: the outline is a rounded top with the arms outside it.
      if (!armsHidden) {
        f(1, armLeftY, 1, ARM_H, AV_INK);
        f(2, armLeftY + ARM_H, 2, 1, AV_INK);
        f(14, armRightY, 1, ARM_H, AV_INK);
        f(12, armRightY + ARM_H, 2, 1, AV_INK);
      }
      if (!armsHidden) f(4, TORSO_Y + TORSO_H, 8, 1, AV_INK); // hem
      f(4, TORSO_Y - 1, 8, 1, AV_INK);

      if (!armsHidden) {
        shade(2, armLeftY, 2, ARM_H, outfit);
        shade(12, armRightY, 2, ARM_H, outfit);
      }
      shade(4, TORSO_Y, 8, TORSO_H, outfit);
      // Shoulder corners are inked so the top of the torso is not a flat rectangle.
      f(4, TORSO_Y, 1, 1, AV_INK);
      f(11, TORSO_Y, 1, 1, AV_INK);
      if (!armsHidden) {
        // A dark seam between each arm and the torso, so the arms read as separate limbs.
        f(4, armLeftY, 1, ARM_H, outfit.dark);
        f(11, armRightY, 1, ARM_H, outfit.dark);
        f(2, armLeftY + ARM_H - 1, 2, 1, skin.base); // hands
        f(12, armRightY + ARM_H - 1, 2, 1, skin.base);
      }
      f(4, TORSO_Y + TORSO_H - 1, 8, 1, trouser.dark); // belt
      if (!facingUp) {
        f(6, TORSO_Y, 4, 1, skin.dark); // neckline
        f(6, TORSO_Y + 1, 4, 1, outfit.hi); // collar
      }
    }
  }

  // --- Head -------------------------------------------------------------------
  if (facingSide) {
    // The profile skull is the front view's skull shifted back a column, so the nose can
    // sit just past its front outline without pushing the sprite wider than the head block.
    roundedPart(2, HEAD_Y, 10, HEAD_H, skin);
    // Ear: one 1px column just in front of the hair mass, at the ear row.
    f(6, 5, 1, 2, skin.dark);
  } else {
    roundedPart(HEAD_X, HEAD_Y, HEAD_W, HEAD_H, skin);
    // Ears: one each side facing the camera; the back view hides them under the hair.
    f(2, 5, 1, 2, skin.base);
    f(2, 6, 1, 1, skin.dark);
    f(13, 5, 1, 2, skin.dark);
  }

  // --- Hair over the head -----------------------------------------------------
  if (!hatted && hairStyle !== 'bald') {
    if (facingSide) {
      // Profile hair: a crown across the top, a fringe over the brow, and the back of the
      // head covered down to the ear row. Long hair continues down behind the shoulders.
      f(2, 0, 10, 1, AV_INK); // top outline
      f(2, 1, 10, 3, hair.base);
      f(2, 1, 10, 1, hair.light);
      f(2, 1, 1, 1, AV_INK); // rounded corner at the back
      f(2, 4, 4, 3, hair.base); // back mass, to the ear row
      f(2, 6, 4, 1, hair.dark);
      f(8, 4, 3, 1, hair.base); // fringe over the brow
      f(9, 4, 1, 1, hair.dark);
      if (hairStyle === 'curly' || hairStyle === 'afro') {
        // Bumpy top and back: scalloped outline and lit bumps.
        f(3, 0, 2, 1, hair.light);
        f(7, 0, 2, 1, hair.light);
        f(1, 2, 1, 5, AV_INK);
        f(2, 2, 1, 1, hair.light);
        f(2, 4, 1, 1, hair.light);
      }
      if (hairStyle === 'afro') {
        // Afro: the mass bulges further back and up, past the head outline.
        f(0, 1, 1, 7, AV_INK);
        f(1, 1, 1, 7, hair.base);
        f(1, 2, 1, 1, hair.light);
        f(1, 5, 1, 1, hair.dark);
      }
      if (hairStyle === 'long') {
        // Falls behind the shoulders, outside the torso's back outline (which is at x=4).
        f(1, 4, 1, 9, AV_INK);
        f(2, 4, 2, 9, hair.base);
        f(2, 4, 2, 1, hair.light);
        f(2, 12, 2, 1, hair.dark);
      }
    } else {
      // Facing away, the back of the head is all hair - the single strongest cue that a
      // character has turned around. Facing the camera it is a real mass with volume, not
      // the thin band across the forehead that a 2px crown reads as.
      const crownH = facingUp ? HEAD_H + 1 : 4;
      f(HEAD_X, CROWN_Y - 1, HEAD_W, 1, AV_INK); // top outline; its corners are left out
      f(2, CROWN_Y, 1, crownH, AV_INK);
      f(13, CROWN_Y, 1, crownH, AV_INK);
      f(HEAD_X, CROWN_Y, HEAD_W, crownH, hair.base);
      f(HEAD_X, CROWN_Y, HEAD_W, 1, hair.light);
      // From behind, long hair runs on into the mass below with no shadow line across it.
      const longBack = facingUp && hairStyle === 'long';
      f(HEAD_X, CROWN_Y + crownH - 1, HEAD_W, 1, longBack ? hair.base : hair.dark);
      f(HEAD_X, CROWN_Y, 1, 1, AV_INK); // rounded crown corners
      f(HEAD_X + HEAD_W - 1, CROWN_Y, 1, 1, AV_INK);
      // A one-pixel highlight streak across the top-left of the hair mass.
      if (!facingUp) f(4, 2, 3, 1, hair.hi);

      if (hairStyle === 'curly') {
        [3, 6, 9].forEach((bx) => f(bx, CROWN_Y - 1, 2, 1, hair.light)); // bumpy silhouette
        f(HEAD_X, 5, 1, 2, hair.base);
        f(HEAD_X + HEAD_W - 1, 5, 1, 2, hair.base);
      } else if (hairStyle === 'short') {
        f(HEAD_X, 5, 1, 2, hair.dark); // sideburns
        f(HEAD_X + HEAD_W - 1, 5, 1, 2, hair.dark);
      } else if (hairStyle === 'long') {
        // Two 2px locks hanging straight down beside the head to about the shoulders. Each has
        // an outline on its outer edge only and a darker tip row, so it reads as hair falling,
        // not as a box. From behind the tip sits one row lower, to meet the mass below.
        const tipY = facingUp ? 13 : 12;
        ([
          [1, 0],
          [13, 15],
        ] as Array<[number, number]>).forEach(([lx, inkX]) => {
          f(inkX, 5, 1, tipY - 5, AV_INK);
          f(lx, 5, 2, tipY - 5, hair.base);
          f(lx, 5, 1, 1, hair.light);
          f(lx, tipY, 2, 1, hair.dark);
        });
        if (facingUp) {
          // From behind the hair falls over the shoulders as one shape with a rounded tip: the
          // mass is square-cornered at the top (it meets the head) and its tip row is inset.
          f(3, TORSO_Y - 1, 10, 4, hair.base);
          f(4, TORSO_Y + 3, 8, 1, hair.dark);
          f(5, TORSO_Y, 2, 1, hair.light);
        }
      }
    }
  } else if (!hatted && hairStyle === 'bald') {
    // A scalp catch-light, on the top of the head, where the light falls.
    if (facingSide) f(4, HEAD_Y, 3, 1, skin.hi);
    else f(5, HEAD_Y, 4, 1, skin.hi);
  }

  // --- Face -------------------------------------------------------------------
  if (!facingUp) {
    // Sits clear of the head's bottom row, which the cel shading already darkens - a mouth
    // drawn onto that row merged with it into what read as a beard.
    if (facingSide) {
      // One eye, near the front of the head, a single pixel wide and two tall. It sits one
      // column in from the shaded front edge, where it has skin on both sides to read against.
      // A catch-light on its top pixel keeps it visible on the darkest skin tones too.
      f(9, 5, 1, 1, mixHex(AV_INK, '#ffffff', 0.75));
      f(9, 6, 1, 1, AV_INK);
      // The nose protrudes one art pixel past the front outline, with its own outline.
      f(13, 5, 1, 1, AV_INK);
      f(13, 6, 1, 2, skin.base);
      f(14, 6, 1, 2, AV_INK);
      f(13, 8, 1, 1, AV_INK);
    } else {
      const eyes: Array<[number, number]> = [
        [5, 5],
        [9, 5],
      ];
      eyes.forEach(([ex, ey]) => {
        f(ex, ey, 2, 2, AV_INK);
        f(ex, ey, 1, 1, mixHex(AV_INK, '#ffffff', 0.75)); // catch-light
      });
    }

    // Blush and mouth, translucent so they tint the skin rather than sit on top of it.
    // Drawn before the glasses so a frame simply covers anything it overlaps.
    if (facingSide) {
      fa(8, 7, 1, 1, ACCENT.red, 0.28);
      fa(11, 7, 1, 1, AV_INK, 0.5); // mouth dab, near the front
    } else {
      fa(4, 7, 2, 1, ACCENT.red, 0.28);
      fa(10, 7, 2, 1, ACCENT.red, 0.28);
      // Full-strength ink across two pixels read as a moustache; this is a soft dab.
      fa(7, 7, 2, 1, AV_INK, 0.45);
    }

    if (avatar?.glasses) {
      // Translucent lenses so the eyes still read through them.
      if (facingSide) {
        // One lens, with its arm running back to the ear.
        // The lens frames the eye; its back edge meets the ear, which is the arm's join.
        fa(8, 5, 2, 2, ACCENT.sky, 0.4);
        f(7, 4, 4, 1, AV_INK);
        f(7, 7, 4, 1, AV_INK);
        f(7, 5, 1, 2, AV_INK);
        f(10, 5, 1, 2, AV_INK);
      } else {
        [4, 9].forEach((lx) => {
          fa(lx, 5, 3, 2, ACCENT.sky, 0.4);
          f(lx, 4, 3, 1, AV_INK);
          f(lx, 7, 3, 1, AV_INK);
          f(lx, 5, 1, 2, AV_INK);
          f(lx + 2, 5, 1, 2, AV_INK);
        });
        f(7, 6, 2, 1, AV_INK); // bridge
      }
    }
  }

  // --- Headwear ---------------------------------------------------------------
  if (hatted && hairStyle !== 'bald') {
    // Under a hat only the hair that is not on the face shows: the back of the head from
    // behind or in profile, and the sideburns from the front. Never a band across the eye row.
    if (facingUp) f(HEAD_X, 6, HEAD_W, 3, hair.base);
    else if (facingSide) f(2, 5, 4, 3, hair.base);
    else {
      f(HEAD_X, 5, 1, 2, hair.dark);
      f(HEAD_X + HEAD_W - 1, 5, 1, 2, hair.dark);
    }
  }

  if (hatStyle === 'cap') {
    const cap = rampFrom(ACCENT.red);
    if (facingSide) {
      // The profile crown sits one row higher than the front's, so its underside clears the
      // eye row: the brim would otherwise cover the one eye a profile has.
      roundedPart(2, CROWN_Y, 10, 3, cap);
    } else {
      // Same for the front: the crown is three rows, so the brim lands on the forehead row
      // and the eyes below it stay clear.
      roundedPart(HEAD_X, CROWN_Y, HEAD_W, 3, cap);
    }
    // The peak follows the direction of travel, which sells the facing at this size more
    // than the face itself does.
    if (facingUp) {
      f(HEAD_X, CROWN_Y - 1, HEAD_W, 1, cap.dark);
    } else if (facingSide) {
      // Profile peak: juts two to three pixels past the face, with its own outline.
      f(12, 2, 3, 1, cap.base);
      f(12, 3, 3, 1, cap.dark);
      f(13, 1, 2, 1, AV_INK);
      f(15, 2, 1, 2, AV_INK);
      f(12, 4, 4, 1, AV_INK);
    } else {
      f(2, 4, 12, 1, cap.dark);
    }
  } else if (hatStyle === 'beanie') {
    const beanie = rampFrom(ACCENT.teal);
    roundedPart(facingSide ? 2 : HEAD_X, CROWN_Y, facingSide ? 10 : HEAD_W, 4, beanie);
    f(facingSide ? 2 : HEAD_X, CROWN_Y + 3, facingSide ? 10 : HEAD_W, 1, beanie.hi); // folded band
    f(7, CROWN_Y - 2, 2, 2, AV_INK);
    f(7, CROWN_Y - 2, 2, 1, ACCENT.yellow); // pom
  }

  // The nape and collar from behind. Drawn after the head so they replace its bottom outline
  // at the centre: the neck is the one place where head and body meet without an outline.
  if (!headOnly && facingUp && hairStyle !== 'long') {
    f(6, HEAD_Y + HEAD_H, 4, 1, skin.dark); // nape
    f(6, TORSO_Y, 4, 1, outfit.dark); // collar, seen from behind
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
