import { describe, expect, it } from 'vitest';
import { createDefaultOfficeMap, createRaceTrackMap, needsRaceTrackUpgrade, RACE_TRACK_VERSION } from '../src/mapsData';
import { findPathAStar, isTileWalkable } from '../src/lib/pathfinding';
import { privateZoneIdAt } from '../src/lib/privateZones';
import { findFreeTileNear, validateKartMove } from '../src/lib/portals';
import { kartWorldFromMap } from '../src/composables/useKartDriving';
import type { GridMap, MapObject } from '../src/types';

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Every tile 4-connected to `start` for which `allow` holds (start included). */
function reachable(map: GridMap, start: { x: number; y: number }, allow: (x: number, y: number) => boolean) {
  const key = (x: number, y: number) => `${x},${y}`;
  const seen = new Set<string>([key(start.x, start.y)]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    for (const [dx, dy] of STEPS) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      if (seen.has(key(x, y)) || !allow(x, y)) continue;
      seen.add(key(x, y));
      queue.push({ x, y });
    }
  }
  return seen;
}

function tilesOfType(map: GridMap, type: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  map.tiles.forEach((row, y) =>
    row.forEach((t, x) => {
      if (t === type) out.push({ x, y });
    }),
  );
  return out;
}

const portalsOf = (map: GridMap): MapObject[] => map.objects.filter((o) => o.type === 'portal');

const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe('race track map', () => {
  const map = createRaceTrackMap();
  const concrete = (x: number, y: number) => map.tiles[y][x] === 'floor_concrete';
  const road = tilesOfType(map, 'floor_concrete');

  /** Length of the concrete run through (x, y) along one axis, counting (x, y) itself. */
  const run = (x: number, y: number, dx: number, dy: number) => {
    let n = 1;
    for (const sign of [1, -1]) {
      for (let k = 1; concrete(x + sign * dx * k, y + sign * dy * k); k++) n++;
    }
    return n;
  };

  it('is an 88x64 karting map with no private zones', () => {
    expect(map.id).toBe('race_track');
    expect(map.width).toBe(88);
    expect(map.height).toBe(64);
    expect(map.allowKarts).toBe(true);
    expect(map.privateZones).toEqual([]);
  });

  it('spawns on a walkable pit tile', () => {
    expect(isTileWalkable(map, map.spawnPoint.x, map.spawnPoint.y)).toBe(true);
    expect(map.tiles[map.spawnPoint.y][map.spawnPoint.x]).toBe('floor_tile');
  });

  it('has one walkable return portal in the pit, at least 4 tiles from spawn', () => {
    const portals = portalsOf(map);
    expect(portals).toHaveLength(1);
    const [portal] = portals;
    expect(portal.data?.target).toBe('@main');
    expect(portal.isBlocking).toBe(false);
    expect(portal.width).toBe(1);
    expect(portal.height).toBe(1);
    expect(chebyshev(portal, map.spawnPoint)).toBeGreaterThanOrEqual(4);
    expect(isTileWalkable(map, portal.x, portal.y)).toBe(true);
    expect(map.tiles[portal.y][portal.x]).toBe('floor_tile');
  });

  it('keeps the return portal at least 2 tiles from the road, so karts never drive over it', () => {
    const [portal] = portalsOf(map);
    expect(concrete(portal.x, portal.y)).toBe(false);
    const nearestRoad = Math.min(...road.map((t) => chebyshev(t, portal)));
    expect(nearestRoad).toBeGreaterThanOrEqual(2);
  });

  it('can be reached on foot from spawn', () => {
    const [portal] = portalsOf(map);
    const path = findPathAStar(map, map.spawnPoint, { x: portal.x, y: portal.y });
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: portal.x, y: portal.y });
  });

  it('connects spawn to the circuit by walkable tiles', () => {
    const start = road[0];
    const path = findPathAStar(map, map.spawnPoint, start);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(start);
  });

  it('has a single closed loop of at least 800 concrete tiles', () => {
    const seen = new Set<string>();
    const components: number[] = [];
    for (const start of road) {
      if (seen.has(`${start.x},${start.y}`)) continue;
      const component = reachable(map, start, concrete);
      component.forEach((k) => seen.add(k));
      components.push(component.size);
    }
    expect(components).toHaveLength(1);
    expect(components[0]).toBeGreaterThanOrEqual(800);
  });

  it('keeps the road six tiles wide on every straight', () => {
    // Top, bottom, left and right straights, sampled along their length.
    for (const x of [26, 30, 56, 60]) expect(run(x, 16, 0, 1)).toBe(6);
    for (const x of [28, 56, 60]) expect(run(x, 48, 0, 1)).toBe(6);
    for (const y of [28, 32, 36]) expect(run(16, y, 1, 0)).toBe(6);
    for (const y of [28, 32, 36]) expect(run(72, y, 1, 0)).toBe(6);
  });

  it('keeps the hairpin, with grass between its two arms', () => {
    // Hairpin: the tip is road, the grass between its two arms is at least 6 tiles wide.
    expect(concrete(42, 27)).toBe(true);
    for (let x = 39; x <= 44; x++) expect(map.tiles[20][x]).toBe('floor_grass');
  });

  it('runs the bottom straight as one uninterrupted straight between its two corners', () => {
    // The bottom corners' tangent points sit at x = 24 and x = 64 on the straight's centre line
    // (y = 48). Every tile from one to the other is road on the same six rows (45 to 50), with
    // grass directly above and below, so the straight has no notch, chicane or step in it.
    for (let x = 24; x <= 63; x++) {
      for (let y = 45; y <= 50; y++) expect(concrete(x, y), `road gap at ${x},${y}`).toBe(true);
      expect(concrete(x, 44), `road above the straight at ${x}`).toBe(false);
      expect(concrete(x, 51), `road below the straight at ${x}`).toBe(false);
    }
    // Nothing pokes up into the infield from the straight.
    for (let x = 26; x <= 62; x++) {
      for (let y = 36; y <= 43; y++) expect(concrete(x, y), `infield road at ${x},${y}`).toBe(false);
    }
  });

  it('never lets the road touch the border: nothing but walls on the outer ring', () => {
    for (let i = 0; i < map.width; i++) {
      expect(concrete(i, 1)).toBe(false);
      expect(concrete(i, map.height - 2)).toBe(false);
    }
    for (let j = 0; j < map.height; j++) {
      expect(concrete(1, j)).toBe(false);
      expect(concrete(map.width - 2, j)).toBe(false);
    }
  });

  it('encloses an infield: the grass inside the loop is cut off from the outside grass', () => {
    // (25, 30) is infield grass; (2, 30) is the grass outside the circuit.
    const fromOutside = reachable(map, map.spawnPoint, (x, y) => !concrete(x, y) && isTileWalkable(map, x, y));
    expect(map.tiles[30][25]).toBe('floor_grass');
    expect(fromOutside.has('2,30')).toBe(true);
    expect(fromOutside.has('25,30')).toBe(false);
  });

});

/** Chebyshev distance from a tile to the nearest road tile, by brute force over the road list. */
function roadDistanceFn(m: GridMap): (x: number, y: number) => number {
  const cells = tilesOfType(m, 'floor_concrete');
  return (x, y) => Math.min(...cells.map((c) => Math.max(Math.abs(c.x - x), Math.abs(c.y - y))));
}

describe('race track tire barriers', () => {
  const map = createRaceTrackMap();
  const tires = map.objects.filter((o) => o.type === 'tires');
  const tireAt = new Set(tires.map((o) => `${o.x},${o.y}`));
  const pitLane = { x: 32, y: 8, width: 4, height: 5 };
  const inPitLane = (x: number, y: number) =>
    x >= pitLane.x && x < pitLane.x + pitLane.width && y >= pitLane.y && y < pitLane.y + pitLane.height;
  const inPit = (x: number, y: number) => x >= 30 && x < 50 && y >= 2 && y < 8;
  const roadDistance = roadDistanceFn(map);

  it('are 1x1 blocking tires objects, and they are the only blocking objects on the track', () => {
    expect(tires.length).toBeGreaterThan(0);
    for (const obj of tires) {
      expect(obj.width).toBe(1);
      expect(obj.height).toBe(1);
      expect(obj.isBlocking).toBe(true);
      expect(obj.name).toBe('Tire Barrier');
    }
    expect(map.objects.filter((o) => o.isBlocking).every((o) => o.type === 'tires')).toBe(true);
  });

  it('sit only on grass: never on road, in the pit, in the pit lane, or on a wall', () => {
    for (const { x, y } of tires) {
      expect(map.tiles[y][x]).toBe('floor_grass');
      expect(inPit(x, y) || inPitLane(x, y)).toBe(false);
    }
  });

  it('sit at Chebyshev distance exactly 2 from the road, leaving one tile of run-off', () => {
    for (const { x, y } of tires) expect(roadDistance(x, y)).toBe(2);
  });

  it('cover every grass tile at distance 2 from the road (the barrier is complete)', () => {
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        if (map.tiles[y][x] !== 'floor_grass' || roadDistance(x, y) !== 2) continue;
        expect(tireAt.has(`${x},${y}`), `barrier gap at ${x},${y}`).toBe(true);
      }
    }
  });

  it('is a sane count for a 6-wide circuit (350 to 450 tires)', () => {
    expect(tires.length).toBeGreaterThanOrEqual(350);
    expect(tires.length).toBeLessThanOrEqual(450);
  });

  it('is not walkable, and is solid for karts', () => {
    for (const { x, y } of tires) {
      expect(isTileWalkable(map, x, y)).toBe(false);
      expect(validateKartMove(map, x, y)).toBe(false);
      expect(kartWorldFromMap(map).surfaceAt(x, y)).toBe('solid');
    }
  });

  it('keeps the barrier closed: from the road, no route reaches 3 tiles out except through the pit lane', () => {
    // Eight-way moves with no corner rule, which is more permissive than any kart or walker, so a
    // pass here rules out diagonal leaks as well. Start: every road tile. Blocked: walls, tires,
    // the pit and the pit lane.
    const open = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < map.width && y < map.height &&
      map.tiles[y][x] !== 'wall_brick' &&
      !tireAt.has(`${x},${y}`) &&
      !inPit(x, y) && !inPitLane(x, y);
    const seen = new Set<string>();
    const queue: [number, number][] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.tiles[y][x] === 'floor_concrete') {
          seen.add(`${x},${y}`);
          queue.push([x, y]);
        }
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx === 0 && dy === 0) || seen.has(`${nx},${ny}`) || !open(nx, ny)) continue;
          seen.add(`${nx},${ny}`);
          queue.push([nx, ny]);
        }
      }
    }
    const reached = queue.map(([x, y]) => roadDistance(x, y));
    expect(Math.max(...reached)).toBeLessThanOrEqual(1);
  });

  it('never lets a free-tile search (spawn, arrivals) land on a tire', () => {
    for (const { x, y } of tires.slice(0, 40)) {
      const free = findFreeTileNear(map, { x, y }, { maxRadius: 3 });
      expect(free).not.toBeNull();
      expect(tireAt.has(`${free!.x},${free!.y}`)).toBe(false);
      expect(isTileWalkable(map, free!.x, free!.y)).toBe(true);
    }
    const spawn = findFreeTileNear(map, map.spawnPoint);
    expect(spawn).toEqual(map.spawnPoint);
  });
});

describe('race track pit lane', () => {
  const map = createRaceTrackMap();
  const lane = { x: 32, y: 8, width: 4, height: 5 };
  const tireAt = new Set(map.objects.filter((o) => o.type === 'tires').map((o) => `${o.x},${o.y}`));

  it('is a 4-wide strip of pit floor from the pit down to the top straight, with no tires in it', () => {
    for (let y = lane.y; y < lane.y + lane.height; y++) {
      for (let x = lane.x; x < lane.x + lane.width; x++) {
        expect(map.tiles[y][x]).toBe('floor_tile');
        expect(tireAt.has(`${x},${y}`)).toBe(false);
      }
    }
    // The strip meets the top straight's road directly below it.
    for (let x = lane.x; x < lane.x + lane.width; x++) expect(map.tiles[lane.y + lane.height][x]).toBe('floor_concrete');
  });

  it('is the only way from spawn onto the road: the walking path enters the lane', () => {
    const road = { x: 33, y: 14 };
    expect(isTileWalkable(map, road.x, road.y)).toBe(true);
    const path = findPathAStar(map, map.spawnPoint, road);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(road);
    const throughLane = path.some((p) => p.x >= lane.x && p.x < lane.x + lane.width && p.y >= lane.y && p.y < lane.y + lane.height);
    expect(throughLane).toBe(true);
  });
});

describe('race track upgrade', () => {
  it('flags a stored 44x32 race track for replacement', () => {
    expect(needsRaceTrackUpgrade({ ...createRaceTrackMap(), width: 44, height: 32 })).toBe(true);
  });

  it('leaves a race track already at the current size and version alone', () => {
    expect(needsRaceTrackUpgrade(createRaceTrackMap())).toBe(false);
  });

  it('flags a version 1 track at the current size', () => {
    expect(needsRaceTrackUpgrade({ ...createRaceTrackMap(), presetVersion: 1 })).toBe(true);
  });

  it('flags a track stored with no version at all', () => {
    const { presetVersion: _unversioned, ...legacy } = createRaceTrackMap();
    expect(needsRaceTrackUpgrade(legacy as GridMap)).toBe(true);
  });

  it('stamps the preset with its version', () => {
    expect(createRaceTrackMap().presetVersion).toBe(RACE_TRACK_VERSION);
    expect(RACE_TRACK_VERSION).toBe(4);
  });

  it('sets mapWideMedia, so everyone on the track is in media range', () => {
    expect(createRaceTrackMap().mapWideMedia).toBe(true);
  });

  it('flags a version 3 track (no map-wide media) for replacement', () => {
    expect(needsRaceTrackUpgrade({ ...createRaceTrackMap(), presetVersion: 3 })).toBe(true);
  });

  it('flags a version 2 track (the chicane layout) for replacement', () => {
    expect(needsRaceTrackUpgrade({ ...createRaceTrackMap(), presetVersion: 2 })).toBe(true);
  });

  it('leaves a version 4 track at the current size alone', () => {
    expect(needsRaceTrackUpgrade({ ...createRaceTrackMap(), presetVersion: 4 })).toBe(false);
  });
});

describe('office map portal', () => {
  const office = createDefaultOfficeMap();
  const spawn = office.spawnPoint;

  it('has exactly one portal, to the race track', () => {
    const portals = portalsOf(office);
    expect(portals).toHaveLength(1);
    expect(portals[0].data?.target).toBe('race_track');
    expect(portals[0].isBlocking).toBe(false);
  });

  it('puts the portal on a walkable tile outside every private zone, not on spawn', () => {
    const [portal] = portalsOf(office);
    expect(portal.x === spawn.x && portal.y === spawn.y).toBe(false);
    expect(isTileWalkable(office, portal.x, portal.y)).toBe(true);
    expect(privateZoneIdAt(office, portal.x, portal.y)).toBeNull();
  });

  it('can be reached from spawn', () => {
    const [portal] = portalsOf(office);
    const path = findPathAStar(office, spawn, { x: portal.x, y: portal.y });
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: portal.x, y: portal.y });
  });
});
