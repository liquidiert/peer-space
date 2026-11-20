import { describe, expect, it } from "vitest";
import {
  AV_HEAD_TOP_Y,
  AV_INK,
  AV_W,
  AVATAR_HEAD_SIZE,
  drawAvatarHead,
  drawAvatarSprite,
} from "../src/lib/avatarSprite";
import { BODY_FRAMES, BODY_PASSING_COLUMN } from "../src/lib/avatarBodyData";
import { mixHex, rampFrom } from "../src/lib/pixelArt";
import type { AvatarCustomization, Direction } from "../src/types";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  alpha: number;
}

/** Records every fillRect with the fill colour and alpha in force when it was drawn. */
function recordingContext() {
  const rects: Rect[] = [];
  let fill = "";
  const alphaStack: number[] = [];
  const ctx = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: string) {
      fill = v;
    },
    globalAlpha: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    save() {
      alphaStack.push(this.globalAlpha);
    },
    restore() {
      this.globalAlpha = alphaStack.pop() ?? 1;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill, alpha: this.globalAlpha });
    },
    fillText() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

const avatar: AvatarCustomization = {
  skinColor: "#c08060",
  hairColor: "#aa3300",
  outfitColor: "#22aa55",
  hairStyle: "short",
  hatStyle: "none",
  glasses: false,
} as AvatarCustomization;

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];
const CX = 100;
const CY = 80;

function headRects(
  opts: {
    scale?: number;
    direction?: Direction;
    avatar?: Partial<AvatarCustomization>;
  } = {},
) {
  const { ctx, rects } = recordingContext();
  drawAvatarHead(
    ctx,
    CX,
    CY,
    opts.scale ?? 2,
    { ...avatar, ...opts.avatar } as AvatarCustomization,
    {
      direction: opts.direction ?? "down",
    },
  );
  return rects;
}

function fullRects(
  opts: {
    scale?: number;
    direction?: Direction;
    avatar?: Partial<AvatarCustomization>;
  } = {},
) {
  const { ctx, rects } = recordingContext();
  drawAvatarSprite(
    ctx,
    0,
    0,
    opts.scale ?? 2,
    { ...avatar, ...opts.avatar } as AvatarCustomization,
    {
      direction: opts.direction ?? "down",
    },
  );
  return rects;
}

describe("AVATAR_HEAD_SIZE", () => {
  it("is the head block in art pixels: the full sprite width, from the top of the box to the bottom of the idle head", () => {
    const idleHead = BODY_FRAMES.down[BODY_PASSING_COLUMN].headBox;
    expect(AVATAR_HEAD_SIZE).toEqual({ w: AV_W, h: AV_HEAD_TOP_Y + idleHead.h });
  });
});

describe("drawAvatarHead", () => {
  it.each(DIRECTIONS)(
    "draws strictly fewer rects than the full sprite (%s)",
    (direction) => {
      const head = headRects({ direction });
      const full = fullRects({ direction });
      expect(head.length).toBeGreaterThan(0);
      expect(head.length).toBeLessThan(full.length);
    },
  );

  it.each([2, 4])(
    "keeps every rect inside a box of AVATAR_HEAD_SIZE * scale centred on (cx, cy) at scale %i",
    (scale) => {
      const left = CX - (AVATAR_HEAD_SIZE.w * scale) / 2;
      const top = CY - (AVATAR_HEAD_SIZE.h * scale) / 2;
      const right = left + AVATAR_HEAD_SIZE.w * scale;
      const bottom = top + AVATAR_HEAD_SIZE.h * scale;

      const cases: Array<Partial<AvatarCustomization>> = [
        {},
        { hairStyle: "afro" },
        { hairStyle: "long", glasses: true },
        { hairStyle: "curly" },
        { hairStyle: "bald" },
        { hatStyle: "beanie" }, // pom sits one row above the skull
        { hatStyle: "cap" },
      ];
      for (const direction of DIRECTIONS) {
        for (const a of cases) {
          for (const rect of headRects({ scale, direction, avatar: a })) {
            expect(rect.x).toBeGreaterThanOrEqual(left);
            expect(rect.y).toBeGreaterThanOrEqual(top);
            expect(rect.x + rect.w).toBeLessThanOrEqual(right);
            expect(rect.y + rect.h).toBeLessThanOrEqual(bottom);
          }
        }
      }
    },
  );

  it("centres the head block on (cx, cy): the head fills the box exactly for the hairstyle that covers it", () => {
    const scale = 2;
    const rects = headRects({ scale, avatar: { hairStyle: "afro" } });
    // Afro halo spans the full width of the head block (art x 1..14) on the outline row.
    const minX = Math.min(...rects.map((r) => r.x));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    expect(minX).toBe(CX - (AVATAR_HEAD_SIZE.w * scale) / 2);
    expect(maxX).toBe(CX + (AVATAR_HEAD_SIZE.w * scale) / 2);
  });

  it("shows the back of the head (hair mass) facing up, and the face facing down", () => {
    const up = headRects({ direction: "up" });
    const down = headRects({ direction: "down" });
    const scale = 2;

    // The hair colour is the base of the hair ramp; its area in art pixels is the hair coverage.
    const hairFill = rampFrom("#aa3300").base;
    const hairArea = (rs: Rect[]) =>
      rs
        .filter((r) => r.fill === hairFill)
        .reduce((sum, r) => sum + (r.w * r.h) / (scale * scale), 0);
    expect(hairArea(up)).toBeGreaterThan(25);
    expect(hairArea(up)).toBeGreaterThan(hairArea(down));

    // An eye is a 1x1 catch-light over a 1x1 ink pixel. Facing the camera there are two; facing
    // away there are none.
    const catchLight = mixHex(AV_INK, "#ffffff", 0.75);
    const eyes = (rs: Rect[]) =>
      rs.filter((r) => r.w === scale && r.h === scale && r.fill === catchLight);
    expect(eyes(down)).toHaveLength(2);
    expect(eyes(up)).toHaveLength(0);

    expect(up.length).not.toBe(down.length);
  });

  it("mirrors the face to the other side when facing left", () => {
    const scale = 2;
    const right = headRects({ scale, direction: "right" });
    const left = headRects({ scale, direction: "left" });
    expect(left.length).toBe(right.length);
    expect(left).not.toEqual(right);
    // Mirror the right-facing rects about the centre of the box (the head is centred on CX).
    // The profile nose protrudes past the head, so the painted extent is not symmetric; the
    // mirrored rects must still be exactly the left-facing ones.
    const key = (r: Rect) => `${r.x},${r.y},${r.w},${r.h},${r.fill},${r.alpha}`;
    const mirrored = right.map((r) => ({ ...r, x: 2 * CX - r.x - r.w }));
    expect(mirrored.map(key).sort()).toEqual(left.map(key).sort());
  });
});
