import { describe, expect, it } from 'vitest';
import {
  findFreeTileNear,
  planPortal,
  portalAt,
  resolvePortalTargetId,
  resolveSpaceMapId,
  tileAt,
} from '../src/lib/portals';
import { isTileWalkable } from '../src/lib/pathfinding';
import type { GridMap, MapObject } from '../src/types';

function makeMap(overrides: Partial<GridMap> = {}): GridMap {
  const width = 8;
  const height = 8;
  return {
    id: 'map-a',
    spaceId: 'space-1',
    name: 'Test Map',
    width,
    height,
    tiles: Array.from({ length: height }, () => Array.from({ length: width }, () => 'floor_wood' as const)),
    objects: [],
    privateZones: [],
    spawnPoint: { x: 2, y: 2 },
    ...overrides,
  };
}

const portal = (x: number, y: number, target = 'race_track'): MapObject => ({
  id: `portal_${x}_${y}`,
  type: 'portal',
  name: 'Portal',
  x,
  y,
  width: 1,
  height: 1,
  isBlocking: false,
  data: { target },
});

describe('tileAt', () => {
  it('rounds a position to the tile it falls in', () => {
    expect(tileAt({ x: 2, y: 3 })).toEqual({ x: 2, y: 3 });
    expect(tileAt({ x: 2.49, y: 3.4 })).toEqual({ x: 2, y: 3 });
    expect(tileAt({ x: 2.5, y: 3.5 })).toEqual({ x: 3, y: 4 });
  });
});

describe('portalAt', () => {
  it('finds the portal covering a tile and nothing elsewhere', () => {
    const map = makeMap({ objects: [portal(5, 5)] });
    expect(portalAt(map, 5, 5)?.type).toBe('portal');
    expect(portalAt(map, 5, 4)).toBeUndefined();
  });
});

describe('findFreeTileNear', () => {
  it('returns the start tile when it is free', () => {
    expect(findFreeTileNear(makeMap(), { x: 2, y: 2 })).toEqual({ x: 2, y: 2 });
  });

  it('skips tiles that are taken and searches outward', () => {
    const taken = new Set(['2,2', '3,2']);
    const found = findFreeTileNear(makeMap(), { x: 2, y: 2 }, {
      isTaken: (x, y) => taken.has(`${x},${y}`),
    });
    expect(found).not.toBeNull();
    expect(taken.has(`${found!.x},${found!.y}`)).toBe(false);
    expect(Math.max(Math.abs(found!.x - 2), Math.abs(found!.y - 2))).toBe(1);
  });

  it('never returns a portal tile', () => {
    const map = makeMap({ objects: [portal(2, 2)] });
    const found = findFreeTileNear(map, { x: 2, y: 2 });
    expect(found).not.toEqual({ x: 2, y: 2 });
    expect(found).not.toBeNull();
  });

  it('avoids private zones when asked to', () => {
    const zone = { id: 'z', name: 'Z', color: '', x: 1, y: 1, width: 3, height: 3 };
    const map = makeMap({ privateZones: [zone] });
    const found = findFreeTileNear(map, { x: 2, y: 2 }, { avoidZones: true, maxRadius: 4 });
    expect(found).not.toBeNull();
    const inZone = found!.x >= 1 && found!.x < 4 && found!.y >= 1 && found!.y < 4;
    expect(inZone).toBe(false);
  });

  it('returns null when nothing qualifies within the radius', () => {
    expect(findFreeTileNear(makeMap(), { x: 2, y: 2 }, { isTaken: () => true, maxRadius: 3 })).toBeNull();
  });
});

describe('planPortal', () => {
  const spec = { id: 'portal_race_track', name: 'Race track', target: 'race_track', label: 'Race track' };

  it('places a 1x1 walkable portal near spawn, never within 2 tiles of it', () => {
    const map = makeMap();
    const obj = planPortal(map, spec);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe('portal');
    expect(obj!.isBlocking).toBe(false);
    expect(obj!.data).toEqual({ target: 'race_track', label: 'Race track' });
    expect(isTileWalkable(map, obj!.x, obj!.y)).toBe(true);
    // Chebyshev distance >= 3 from spawn: joiners cannot step onto it by accident.
    expect(Math.max(Math.abs(obj!.x - 2), Math.abs(obj!.y - 2))).toBe(3);
  });

  it('moves outward when the whole distance-3 ring is blocked, still never within 2 of spawn', () => {
    // Block every tile at distance 3 from spawn (2,2) on the 8x8 map, so the portal must go to 4+.
    const blockers: MapObject[] = [];
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const d = Math.max(Math.abs(x - 2), Math.abs(y - 2));
        if (d === 3) {
          blockers.push({ id: `b${x}_${y}`, type: 'plant', name: 'P', x, y, width: 1, height: 1, isBlocking: true });
        }
      }
    }
    const obj = planPortal(makeMap({ objects: blockers }), spec);
    expect(obj).not.toBeNull();
    expect(Math.max(Math.abs(obj!.x - 2), Math.abs(obj!.y - 2))).toBeGreaterThanOrEqual(4);
    expect(isTileWalkable(makeMap({ objects: blockers }), obj!.x, obj!.y)).toBe(true);
  });

  it('is idempotent: a map that already has a portal gets none', () => {
    expect(planPortal(makeMap({ objects: [portal(5, 5)] }), spec)).toBeNull();
  });

  it('picks a non-zone tile even when the nearest tiles are in a zone', () => {
    // Zone covers the 3x3 block around spawn, so the portal must go further out.
    const zone = { id: 'z', name: 'Z', color: '', x: 1, y: 1, width: 3, height: 3 };
    const obj = planPortal(makeMap({ privateZones: [zone] }), spec);
    expect(obj).not.toBeNull();
    const inZone = obj!.x >= 1 && obj!.x < 4 && obj!.y >= 1 && obj!.y < 4;
    expect(inZone).toBe(false);
  });

  it('avoids blocking objects', () => {
    const blocker: MapObject = {
      id: 'b', type: 'plant', name: 'Plant', x: 1, y: 2, width: 1, height: 1, isBlocking: true,
    };
    const obj = planPortal(makeMap({ objects: [blocker] }), spec);
    expect(obj).not.toBeNull();
    expect(obj!.x === 1 && obj!.y === 2).toBe(false);
  });
});

describe('resolveSpaceMapId', () => {
  const maps = [
    { id: 'space-1:race_track', spaceId: 'space-1' },
    { id: 'race_track', spaceId: 'main' }, // legacy bare id, owned by another space
    { id: 'office_default', spaceId: 'main' }, // legacy bare id owned by this space
    { id: 'space-2:office_default', spaceId: 'space-2' },
  ];
  const lookup = (id: string) => maps.find((m) => m.id === id);

  it('prefers the namespaced copy', () => {
    expect(resolveSpaceMapId('space-1', 'race_track', lookup)).toBe('space-1:race_track');
  });

  it('accepts a bare legacy id that belongs to the same space', () => {
    expect(resolveSpaceMapId('main', 'office_default', lookup)).toBe('office_default');
  });

  it('never resolves to another space', () => {
    expect(resolveSpaceMapId('space-2', 'race_track', lookup)).toBeNull();
  });

  it('returns null for a preset the space does not have', () => {
    expect(resolveSpaceMapId('space-1', 'beach_retreat', lookup)).toBeNull();
  });
});

describe('resolvePortalTargetId', () => {
  const maps = [
    { id: 'space-1:office_default', spaceId: 'space-1' },
    { id: 'space-1:race_track', spaceId: 'space-1' },
    { id: 'space-2:race_track', spaceId: 'space-2' },
  ];
  const lookup = (id: string) => maps.find((m) => m.id === id);

  it("'@main' resolves to the space's active map", () => {
    expect(resolvePortalTargetId('space-1', 'space-1:office_default', '@main', lookup)).toBe('space-1:office_default');
  });

  it("'@main' is not a preset id and does not reach another space's active map", () => {
    expect(resolvePortalTargetId('space-2', 'space-1:office_default', '@main', lookup)).toBeNull();
  });

  it('resolves a preset id within the space, not the active map', () => {
    expect(resolvePortalTargetId('space-1', 'space-1:office_default', 'race_track', lookup)).toBe('space-1:race_track');
  });

  it('returns null for an unknown preset', () => {
    expect(resolvePortalTargetId('space-1', 'space-1:office_default', 'nowhere', lookup)).toBeNull();
  });
});
