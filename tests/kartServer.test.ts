import { describe, expect, it } from 'vitest';
import { directionFromHeading } from '../src/lib/kart';
import { isTileWalkable } from '../src/lib/pathfinding';
import {
  findFreeTileNear,
  headingFromDirection,
  isTileBlocked,
  tileAt,
  validateKartMove,
} from '../src/lib/portals';
import type { GridMap, MapObject, TileType } from '../src/types';

function makeMap(overrides: Partial<GridMap> = {}): GridMap {
  const width = 8;
  const height = 8;
  return {
    id: 'race',
    spaceId: 'space-1',
    name: 'Test Track',
    width,
    height,
    tiles: Array.from({ length: height }, () => Array.from({ length: width }, () => 'floor_grass' as const)),
    objects: [],
    privateZones: [],
    spawnPoint: { x: 2, y: 2 },
    allowKarts: true,
    ...overrides,
  };
}

function withTile(map: GridMap, x: number, y: number, tile: TileType): GridMap {
  map.tiles[y][x] = tile;
  return map;
}

const blockingObject = (x: number, y: number): MapObject => ({
  id: `obj_${x}_${y}`,
  type: 'plant',
  name: 'Tire Stack',
  x,
  y,
  width: 1,
  height: 1,
  isBlocking: true,
});

describe('headingFromDirection', () => {
  it('maps each cardinal direction to its heading: right 0, down PI/2, left PI, up -PI/2', () => {
    expect(headingFromDirection('right')).toBe(0);
    expect(headingFromDirection('down')).toBeCloseTo(Math.PI / 2);
    expect(headingFromDirection('left')).toBeCloseTo(Math.PI);
    expect(headingFromDirection('up')).toBeCloseTo(-Math.PI / 2);
  });

  it('round-trips through directionFromHeading', () => {
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      expect(directionFromHeading(headingFromDirection(dir))).toBe(dir);
    }
  });
});

describe('validateKartMove', () => {
  it('accepts integer and fractional positions on open floor', () => {
    const map = makeMap();
    expect(validateKartMove(map, 2, 2)).toBe(true);
    expect(validateKartMove(map, 2.3, 3.7)).toBe(true);
    expect(validateKartMove(map, 3.4, 4.49)).toBe(true);
  });

  it('accepts the full closed range [0, width-1] x [0, height-1]', () => {
    const map = makeMap();
    expect(validateKartMove(map, 0, 0)).toBe(true);
    expect(validateKartMove(map, 7, 7)).toBe(true);
    expect(validateKartMove(map, 0, 7)).toBe(true);
  });

  it('rejects positions outside the map, even by a fraction', () => {
    const map = makeMap();
    expect(validateKartMove(map, -0.01, 2)).toBe(false);
    expect(validateKartMove(map, 2, -0.5)).toBe(false);
    expect(validateKartMove(map, 7.01, 2)).toBe(false);
    expect(validateKartMove(map, 2, 7.2)).toBe(false);
  });

  it('rejects non-finite positions', () => {
    const map = makeMap();
    expect(validateKartMove(map, Number.NaN, 2)).toBe(false);
    expect(validateKartMove(map, 2, Number.POSITIVE_INFINITY)).toBe(false);
    expect(validateKartMove(map, Number.NEGATIVE_INFINITY, 2)).toBe(false);
  });

  it('rejects a position whose rounded tile is a wall, water, or edge-blocking tile', () => {
    for (const tile of ['wall_brick', 'wall_wood', 'water'] as const) {
      const map = withTile(makeMap(), 4, 4, tile);
      expect(validateKartMove(map, 4, 4)).toBe(false);
      // 4.2 rounds to tile 4 as well, so a float inside the wall tile is blocked too.
      expect(validateKartMove(map, 4.2, 4.1)).toBe(false);
      // 3.4 rounds to tile 3, which is open.
      expect(validateKartMove(map, 3.4, 4)).toBe(true);
    }
  });

  it('rejects a position whose rounded tile is covered by a blocking object', () => {
    const map = makeMap({ objects: [blockingObject(5, 5)] });
    expect(validateKartMove(map, 5, 5)).toBe(false);
    expect(validateKartMove(map, 5.3, 5.4)).toBe(false);
    expect(validateKartMove(map, 5.6, 5)).toBe(true); // rounds to tile 6
  });

  it('ignores non-blocking objects such as portals', () => {
    const map = makeMap({
      objects: [{ ...blockingObject(5, 5), isBlocking: false, type: 'portal', data: { target: '@main' } }],
    });
    expect(validateKartMove(map, 5, 5)).toBe(true);
  });
});

describe('isTileBlocked', () => {
  it('treats off-map tiles as blocked', () => {
    const map = makeMap();
    expect(isTileBlocked(map, -1, 0)).toBe(true);
    expect(isTileBlocked(map, 0, 8)).toBe(true);
    expect(isTileBlocked(map, 8, 0)).toBe(true);
  });

  it('blocks walls, water and blocking objects, not open floor', () => {
    const map = makeMap({ objects: [blockingObject(3, 3)] });
    withTile(map, 1, 1, 'water');
    expect(isTileBlocked(map, 1, 1)).toBe(true);
    expect(isTileBlocked(map, 3, 3)).toBe(true);
    expect(isTileBlocked(map, 2, 2)).toBe(false);
  });
});

describe('dismount snapping', () => {
  // A kart at float (2.3, 2.6) is standing on tile (2, 3).
  const spot = (map: GridMap, p: { x: number; y: number }, taken: Set<string> = new Set()) =>
    findFreeTileNear(map, tileAt(p), {
      maxRadius: 10,
      isTaken: (x, y) => taken.has(`${x},${y}`),
    });

  it('keeps an open tile under the kart as is, as an integer', () => {
    const found = spot(makeMap(), { x: 2.3, y: 2.6 });
    expect(found).toEqual({ x: 2, y: 3 });
    expect(Number.isInteger(found!.x) && Number.isInteger(found!.y)).toBe(true);
  });

  it('never lands on a portal tile, even when the kart is standing on one', () => {
    const map = makeMap({
      objects: [{ ...blockingObject(2, 3), isBlocking: false, type: 'portal', name: 'Back', data: { target: '@main' } }],
    });
    const found = spot(map, { x: 2.3, y: 2.6 });
    expect(found).not.toBeNull();
    expect(found).not.toEqual({ x: 2, y: 3 });
    expect(isTileWalkable(map, found!.x, found!.y)).toBe(true);
    expect(map.objects.some((o) => o.type === 'portal' && o.x === found!.x && o.y === found!.y)).toBe(false);
  });

  it('skips tiles held by walking users and never returns a blocked tile', () => {
    const map = makeMap({ objects: [blockingObject(2, 2)] });
    const found = spot(map, { x: 2, y: 3 }, new Set(['2,3', '1,3']));
    expect(found).not.toBeNull();
    expect(Number.isInteger(found!.x) && Number.isInteger(found!.y)).toBe(true);
    expect(isTileWalkable(map, found!.x, found!.y)).toBe(true);
    expect(found).not.toEqual({ x: 2, y: 2 });
    expect(found).not.toEqual({ x: 2, y: 3 });
    expect(found).not.toEqual({ x: 1, y: 3 });
  });
});
