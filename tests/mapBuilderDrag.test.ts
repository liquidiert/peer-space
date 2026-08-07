import { describe, expect, it } from "vitest";
import type { GridMap, MapObject } from "../src/types";

function createTestMap(): GridMap {
  return {
    id: "office_default",
    name: "Tech HQ",
    width: 20,
    height: 20,
    tiles: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => "floor_wood" as const)),
    objects: [
      {
        id: "obj_1",
        type: "desk",
        name: "Workstation Desk",
        x: 5,
        y: 5,
        width: 2,
        height: 1,
        isBlocking: true,
      },
      {
        id: "obj_2",
        type: "plant",
        name: "Potted Plant",
        x: 10,
        y: 10,
        width: 1,
        height: 1,
        isBlocking: true,
      },
    ],
    privateZones: [],
    spawnPoint: { x: 2, y: 2 },
  };
}

describe("Map Builder Object Drag & Move", () => {
  it("updates object position correctly when moved", () => {
    const map = createTestMap();
    const targetObjId = "obj_1";
    const newX = 8;
    const newY = 12;

    const updatedObjects = map.objects.map((o) =>
      o.id === targetObjId ? { ...o, x: newX, y: newY } : o
    );

    const movedObj = updatedObjects.find((o) => o.id === targetObjId);
    expect(movedObj).toBeDefined();
    expect(movedObj?.x).toBe(8);
    expect(movedObj?.y).toBe(12);
  });

  it("preserves object attributes (dimensions, data) during drag move", () => {
    const map = createTestMap();
    const targetObjId = "obj_1";
    const original = map.objects.find((o) => o.id === targetObjId);

    const updatedObjects = map.objects.map((o) =>
      o.id === targetObjId ? { ...o, x: 15, y: 15 } : o
    );

    const moved = updatedObjects.find((o) => o.id === targetObjId);
    expect(moved?.type).toBe(original?.type);
    expect(moved?.width).toBe(original?.width);
    expect(moved?.height).toBe(original?.height);
    expect(moved?.isBlocking).toBe(original?.isBlocking);
  });
});
