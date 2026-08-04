import { describe, expect, it } from 'vitest';
import { findPathAStar, isTileWalkable, occupiedKeySet } from '../src/lib/pathfinding';
import type { GridMap } from '../src/types';

/**
 * Coverage for "users can't step over each other": both the low-level occupancy check
 * and the A* pathfinder (used by click-to-navigate) need to treat other users' current
 * tiles as obstacles, the same way they already treat walls/blocking objects.
 */

function makeOpenMap(width = 8, height = 8): GridMap {
  return {
    id: 'test-map',
    name: 'Test Map',
    width,
    height,
    tiles: Array.from({ length: height }, () => Array.from({ length: width }, () => 'floor_wood' as const)),
    objects: [],
    privateZones: [],
    spawnPoint: { x: 0, y: 0 },
  };
}

describe('isTileWalkable with occupied tiles', () => {
  it('treats an occupied tile as unwalkable', () => {
    const map = makeOpenMap();
    const occupied = occupiedKeySet([{ x: 3, y: 3 }]);
    expect(isTileWalkable(map, 3, 3, occupied)).toBe(false);
  });

  it('leaves unoccupied tiles walkable', () => {
    const map = makeOpenMap();
    const occupied = occupiedKeySet([{ x: 3, y: 3 }]);
    expect(isTileWalkable(map, 4, 4, occupied)).toBe(true);
  });

  it('is unaffected when no occupied set is passed (backward compatible)', () => {
    const map = makeOpenMap();
    expect(isTileWalkable(map, 3, 3)).toBe(true);
  });
});

describe('findPathAStar routes around occupied tiles', () => {
  it('does not path directly through a tile someone else is standing on', () => {
    const map = makeOpenMap();
    const occupied = occupiedKeySet([{ x: 2, y: 0 }]);
    const path = findPathAStar(map, { x: 0, y: 0 }, { x: 4, y: 0 }, occupied);

    expect(path.length).toBeGreaterThan(0);
    expect(path.some((p) => p.x === 2 && p.y === 0)).toBe(false);
  });

  it('still finds the direct route when nobody is in the way', () => {
    const map = makeOpenMap();
    const path = findPathAStar(map, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it('redirects to the nearest free neighbor when the destination itself is occupied', () => {
    const map = makeOpenMap();
    const occupied = occupiedKeySet([{ x: 4, y: 4 }]);
    const path = findPathAStar(map, { x: 0, y: 0 }, { x: 4, y: 4 }, occupied);

    expect(path.length).toBeGreaterThan(0);
    const finalStep = path[path.length - 1];
    expect(finalStep).not.toEqual({ x: 4, y: 4 });
    // The reroute should land adjacent to the original (blocked) destination.
    expect(Math.abs(finalStep.x - 4) + Math.abs(finalStep.y - 4)).toBe(1);
  });

  it('returns no path when boxed in on all four sides by other users', () => {
    const map = makeOpenMap();
    const occupied = occupiedKeySet([
      { x: 3, y: 2 },
      { x: 3, y: 4 },
      { x: 2, y: 3 },
      { x: 4, y: 3 },
    ]);
    const path = findPathAStar(map, { x: 0, y: 0 }, { x: 3, y: 3 }, occupied);
    expect(path).toEqual([]);
  });
});
