import type { GridMap, Point } from '../types';
import { privateZoneIdAt } from './privateZones';

/**
 * Extra cost for stepping onto a tile inside a private zone, on top of the normal cost of 1.
 *
 * Walking through a zone briefly puts the user into it and disrupts calls, so click-to-walk
 * prefers a detour of up to this many extra steps per zone tile. It is a penalty rather than
 * a block: if the only corridor runs through a zone, the route still goes through it.
 * The zone the walk starts in and the zone it ends in are exempt, so the user can always
 * walk out of where they are and into where they are going.
 */
export const ZONE_STEP_PENALTY = 20;

/** Build the `occupied` key set findPathAStar/isTileWalkable expect from a list of positions. */
export function occupiedKeySet(positions: Point[]): Set<string> {
  return new Set(positions.map((p) => `${p.x},${p.y}`));
}

export function isTileWalkable(map: GridMap, x: number, y: number, occupied?: Set<string>): boolean {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) return false;

  const tile = map.tiles[y]?.[x];
  if (tile === 'wall_brick' || tile === 'wall_wood' || tile === 'water') {
    return false;
  }

  const blockingObj = map.objects.find(
    (obj) => obj.isBlocking && x >= obj.x && x < obj.x + obj.width && y >= obj.y && y < obj.y + obj.height
  );
  if (blockingObj) return false;

  if (occupied?.has(`${x},${y}`)) return false;

  return true;
}

/**
 * A* from `start` to `end`, returning the steps to take (start excluded, destination included),
 * or [] when there is no route. Stepping into a private zone costs `ZONE_STEP_PENALTY` extra,
 * except for the zones of the start and end tiles; see that constant for why.
 */
export function findPathAStar(map: GridMap, start: Point, end: Point, occupied?: Set<string>): Point[] {
  if (!map) return [];
  if (start.x === end.x && start.y === end.y) return [];

  // If destination tile itself is blocked, find the nearest walkable neighboring tile
  let target = { ...end };
  if (!isTileWalkable(map, target.x, target.y, occupied)) {
    const neighbors = [
      { x: end.x, y: end.y - 1 },
      { x: end.x, y: end.y + 1 },
      { x: end.x - 1, y: end.y },
      { x: end.x + 1, y: end.y },
    ].filter((p) => isTileWalkable(map, p.x, p.y, occupied));

    if (neighbors.length === 0) return [];
    neighbors.sort(
      (a, b) =>
        Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y)
    );
    target = neighbors[0];
  }

  if (start.x === target.x && start.y === target.y) return [];

  // Zone of every tile (row-major, index = y * width + x), computed once so expansions don't
  // rescan the zone lists. Zones the walk may pass through freely are the start's and the end's.
  const startZone = privateZoneIdAt(map, start.x, start.y);
  const endZone = privateZoneIdAt(map, end.x, end.y);
  const zoneAt: (string | null)[] = new Array(map.width * map.height);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      zoneAt[y * map.width + x] = privateZoneIdAt(map, x, y);
    }
  }

  // Cost of stepping onto (x, y). Manhattan distance stays admissible and consistent because
  // every step costs at least 1 and the penalty only ever adds to that.
  const stepCost = (x: number, y: number) => {
    const zone = zoneAt[y * map.width + x];
    const penalised = zone !== null && zone !== startZone && zone !== endZone;
    return penalised ? 1 + ZONE_STEP_PENALTY : 1;
  };

  interface ANode {
    x: number;
    y: number;
    g: number;
    h: number;
    f: number;
    parent: ANode | null;
  }

  const key = (x: number, y: number) => `${x},${y}`;
  const openList: ANode[] = [];
  const closedSet = new Set<string>();

  const startNode: ANode = {
    x: start.x,
    y: start.y,
    g: 0,
    h: Math.abs(start.x - target.x) + Math.abs(start.y - target.y),
    f: Math.abs(start.x - target.x) + Math.abs(start.y - target.y),
    parent: null,
  };

  openList.push(startNode);

  // Maximum search steps to avoid performance issues on huge grids
  let maxSteps = 2000;

  while (openList.length > 0 && maxSteps > 0) {
    maxSteps--;
    openList.sort((a, b) => a.f - b.f);
    const current = openList.shift()!;
    const currentKey = key(current.x, current.y);

    if (current.x === target.x && current.y === target.y) {
      const path: Point[] = [];
      let curr: ANode | null = current;
      while (curr && (curr.x !== start.x || curr.y !== start.y)) {
        path.unshift({ x: curr.x, y: curr.y });
        curr = curr.parent;
      }
      return path;
    }

    closedSet.add(currentKey);

    const dirs = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];

    for (const dir of dirs) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      const nKey = key(nx, ny);

      if (closedSet.has(nKey)) continue;
      if (!isTileWalkable(map, nx, ny, occupied)) continue;

      const gScore = current.g + stepCost(nx, ny);
      let neighbor = openList.find((n) => n.x === nx && n.y === ny);

      if (!neighbor) {
        const hScore = Math.abs(nx - target.x) + Math.abs(ny - target.y);
        neighbor = {
          x: nx,
          y: ny,
          g: gScore,
          h: hScore,
          f: gScore + hScore,
          parent: current,
        };
        openList.push(neighbor);
      } else if (gScore < neighbor.g) {
        neighbor.g = gScore;
        neighbor.f = gScore + neighbor.h;
        neighbor.parent = current;
      }
    }
  }

  return [];
}
