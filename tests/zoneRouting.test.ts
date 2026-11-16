import { describe, expect, it } from 'vitest';
import { findPathAStar } from '../src/lib/pathfinding';
import { privateZoneIdAt } from '../src/lib/privateZones';
import type { GridMap, MapObject, PrivateZone } from '../src/types';

/**
 * Coverage for private-zone lookup (shared by the server and the pathfinder) and for
 * click-to-walk routes avoiding private zones: a zone step costs extra, but is not blocked,
 * and the zones of the start and end tiles are exempt.
 */

function makeMap(opts: { width?: number; height?: number; privateZones?: PrivateZone[]; objects?: MapObject[] } = {}): GridMap {
  const width = opts.width ?? 8;
  const height = opts.height ?? 5;
  return {
    id: 'test-map',
    name: 'Test Map',
    width,
    height,
    tiles: Array.from({ length: height }, () => Array.from({ length: width }, () => 'floor_wood' as const)),
    objects: opts.objects ?? [],
    privateZones: opts.privateZones ?? [],
    spawnPoint: { x: 0, y: 0 },
  };
}

function zone(id: string, x: number, y: number, width: number, height: number): PrivateZone {
  return { id, name: id, color: '#000000', x, y, width, height };
}

function desk(id: string, x: number, y: number): MapObject {
  return { id, type: 'desk', name: 'Desk', x, y, width: 2, height: 1, isBlocking: true };
}

describe('privateZoneIdAt', () => {
  it('returns the explicit zone id for tiles inside its rectangle', () => {
    const map = makeMap({ privateZones: [zone('room_a', 1, 1, 2, 2)] });
    expect(privateZoneIdAt(map, 1, 1)).toBe('room_a');
    expect(privateZoneIdAt(map, 2, 2)).toBe('room_a');
  });

  it('returns null for tiles just outside an explicit zone', () => {
    const map = makeMap({ privateZones: [zone('room_a', 1, 1, 2, 2)] });
    expect(privateZoneIdAt(map, 3, 1)).toBeNull();
    expect(privateZoneIdAt(map, 1, 3)).toBeNull();
  });

  it('returns desk_zone_<id> on the desk tile and on the row directly below it', () => {
    const map = makeMap({ objects: [desk('d1', 2, 2)] });
    expect(privateZoneIdAt(map, 2, 2)).toBe('desk_zone_d1');
    expect(privateZoneIdAt(map, 3, 2)).toBe('desk_zone_d1');
    expect(privateZoneIdAt(map, 2, 3)).toBe('desk_zone_d1');
    expect(privateZoneIdAt(map, 3, 3)).toBe('desk_zone_d1');
  });

  it('returns null two rows below a desk', () => {
    const map = makeMap({ objects: [desk('d1', 2, 2)] });
    expect(privateZoneIdAt(map, 2, 4)).toBeNull();
  });

  it('returns null for tiles outside everything', () => {
    const map = makeMap({ privateZones: [zone('room_a', 1, 1, 2, 2)], objects: [desk('d1', 5, 0)] });
    expect(privateZoneIdAt(map, 0, 0)).toBeNull();
    expect(privateZoneIdAt(map, 7, 4)).toBeNull();
  });
});

describe('findPathAStar avoids private zones', () => {
  it('takes a short open detour rather than crossing a zone', () => {
    // Zone covers (3..5, 2); the straight route along row 2 crosses it, row 1 is open.
    const zoneTiles = [
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ];
    const map = makeMap({ width: 9, height: 5, privateZones: [zone('room_a', 3, 2, 3, 1)] });
    const path = findPathAStar(map, { x: 0, y: 2 }, { x: 8, y: 2 });

    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: 8, y: 2 });
    for (const t of zoneTiles) {
      expect(path.some((p) => p.x === t.x && p.y === t.y)).toBe(false);
    }
  });

  it('still crosses the zone when it is the only corridor', () => {
    // A one-tile-high corridor: the zone (2..4, 0) is unavoidable, but not impassable.
    const map = makeMap({ width: 7, height: 1, privateZones: [zone('room_a', 2, 0, 3, 1)] });
    const path = findPathAStar(map, { x: 0, y: 0 }, { x: 6, y: 0 });

    expect(path).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 0 },
      { x: 6, y: 0 },
    ]);
  });

  it('enters the destination zone when the destination is inside one', () => {
    // Destination (6,2) sits in the zone at the end of the row; the end zone is exempt,
    // so the route goes straight in rather than detouring around it.
    const map = makeMap({ width: 8, height: 5, privateZones: [zone('room_a', 4, 2, 3, 1)] });
    const path = findPathAStar(map, { x: 0, y: 2 }, { x: 6, y: 2 });

    expect(path[path.length - 1]).toEqual({ x: 6, y: 2 });
    expect(path).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });

  it('lets a user standing in a zone walk straight out of it', () => {
    // Start (1,2) is in the zone (0..2, 2); leaving through the zone must not be penalised.
    const map = makeMap({ width: 8, height: 5, privateZones: [zone('room_a', 0, 2, 3, 1)] });
    const path = findPathAStar(map, { x: 1, y: 2 }, { x: 6, y: 2 });

    expect(path).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });

  it('routes around a desk front rather than through it when a detour exists', () => {
    // Desk at (3,2) makes zone tiles (3,2),(4,2) and (3,3),(4,3); row 1 stays open.
    const map = makeMap({ width: 8, height: 5, objects: [desk('d1', 3, 2)] });
    const path = findPathAStar(map, { x: 0, y: 3 }, { x: 7, y: 3 });
    const inDeskZone = (p: { x: number; y: number }) => privateZoneIdAt(map, p.x, p.y) !== null;

    expect(path[path.length - 1]).toEqual({ x: 7, y: 3 });
    expect(path.some(inDeskZone)).toBe(false);
  });
});
