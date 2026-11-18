import { describe, expect, it } from "vitest";
import {
  AVATAR_HEAD_SIZE,
  drawAvatarHead,
  drawAvatarSprite,
} from "../src/lib/avatarSprite";
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
  it("is the head block in art pixels: the face, hair and hat, without the torso", () => {
    expect(AVATAR_HEAD_SIZE).toEqual({ w: 14, h: 11 });
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

    // Facing away: the hair mass runs from the crown row down the back of the skull (8 art px
    // tall, HEAD_H + 1) across its full width (10 art px).
    const hairBack = (rs: Rect[]) =>
      rs.some((r) => r.w === 10 * scale && r.h === 8 * scale);
    expect(hairBack(up)).toBe(true);
    expect(hairBack(down)).toBe(false);

    // Facing the camera: two 2x2 eyes. Facing away: no eyes at all.
    const eyes = (rs: Rect[]) =>
      rs.filter(
        (r) => r.w === 2 * scale && r.h === 2 * scale && r.fill === "#1e293b",
      );
    expect(eyes(down).length).toBeGreaterThanOrEqual(2);
    expect(eyes(up)).toHaveLength(0);

    expect(up.length).not.toBe(down.length);
  });

  it("mirrors the face to the other side when facing left", () => {
    const scale = 2;
    const right = headRects({ scale, direction: "right" });
    const left = headRects({ scale, direction: "left" });
    expect(left.length).toBe(right.length);
    expect(left).not.toEqual(right);
    // Mirrored about the block's centre column, so the bounding box is unchanged.
    const span = (rs: Rect[]) => [
      Math.min(...rs.map((r) => r.x)),
      Math.max(...rs.map((r) => r.x + r.w)),
    ];
    expect(span(left)).toEqual(span(right));
  });
});
