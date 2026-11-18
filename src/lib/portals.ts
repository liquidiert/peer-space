import type { Direction, GridMap, MapObject, Point, PortalData } from '../types';
import { isTileWalkable } from './pathfinding';
import { privateZoneIdAt } from './privateZones';

/** Portal target meaning "the space's main (active) map". */
export const PORTAL_MAIN_TARGET = '@main';

/**
 * The tile a (possibly fractional) position stands on. Positions are rounded to the nearest
 * tile, so every tile lookup on the server uses this rule.
 */
export function tileAt(p: Point): Point {
  return { x: Math.floor(p.x + 0.5), y: Math.floor(p.y + 0.5) };
}

/** The portal object covering tile (x, y), if any. */
export function portalAt(map: GridMap, x: number, y: number): MapObject | undefined {
  return map.objects.find(
    (o) =>
      o.type === 'portal' &&
      x >= o.x && x < o.x + o.width &&
      y >= o.y && y < o.y + o.height,
  );
}

export function hasPortal(map: GridMap): boolean {
  return map.objects.some((o) => o.type === 'portal');
}

/**
 * Whether a tile stops a walker or a kart: off the map, a wall, water, or covered by a blocking
 * object. Users never count here; occupancy is a separate check.
 */
export function isTileBlocked(map: GridMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  const tile = map.tiles[y]?.[x];
  if (tile === 'wall_brick' || tile === 'wall_wood' || tile === 'water') return true;
  return map.objects.some(
    (o) =>
      o.isBlocking &&
      x >= o.x && x < o.x + o.width &&
      y >= o.y && y < o.y + o.height,
  );
}

/**
 * Whether a kart may be at float position (x, y). The position must be finite and inside
 * [0, width-1] x [0, height-1], and the tile it rounds into must not be blocked. Karts ignore
 * other users, so this is the whole check.
 */
export function validateKartMove(map: GridMap, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x > map.width - 1 || y > map.height - 1) return false;
  const tile = tileAt({ x, y });
  return !isTileBlocked(map, tile.x, tile.y);
}

/**
 * The heading a kart takes when mounted by a user facing `dir` (screen coords, y grows downward):
 * right 0, down PI/2, left PI, up -PI/2. Inverse of directionFromHeading for the four cardinals.
 */
export function headingFromDirection(dir: Direction): number {
  switch (dir) {
    case 'right':
      return 0;
    case 'down':
      return Math.PI / 2;
    case 'left':
      return Math.PI;
    case 'up':
      return -Math.PI / 2;
  }
}

/**
 * Nearest walkable tile to `start`, searching outward in square rings (start first).
 *
 * A tile qualifies when it is walkable, is not a portal (standing on one would not trigger
 * anything, and arrivals must not bounce), is not private-zone when `avoidZones` is set, and
 * `isTaken` does not claim it. Returns null when nothing qualifies within `maxRadius`.
 */
export function findFreeTileNear(
  map: GridMap,
  start: Point,
  options: {
    isTaken?: (x: number, y: number) => boolean;
    avoidZones?: boolean;
    maxRadius?: number;
  } = {},
): Point | null {
  const maxRadius = options.maxRadius ?? 10;
  const qualifies = (x: number, y: number) =>
    isTileWalkable(map, x, y) &&
    !portalAt(map, x, y) &&
    (!options.avoidZones || privateZoneIdAt(map, x, y) === null) &&
    !options.isTaken?.(x, y);

  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
        const x = start.x + dx;
        const y = start.y + dy;
        if (qualifies(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/**
 * Tiles within this Chebyshev distance of spawn never get a planned portal. A portal right next to
 * spawn means joiners step onto it by accident, so placement starts at distance 3.
 */
export const PORTAL_MIN_SPAWN_DISTANCE = 2;

/**
 * A new 1x1 portal object for `map`, on the free non-zone tile nearest its spawn point, at least
 * PORTAL_MIN_SPAWN_DISTANCE + 1 tiles away from it. Returns null when the map already has a portal,
 * so calling it on a map that was already backfilled is a no-op. The caller pushes the result onto
 * map.objects.
 */
export function planPortal(
  map: GridMap,
  spec: { id: string; name: string; target: string; label?: string },
): MapObject | null {
  if (hasPortal(map)) return null;
  const spawn = map.spawnPoint;
  const tile = findFreeTileNear(map, spawn, {
    avoidZones: true,
    maxRadius: Math.max(map.width, map.height),
    isTaken: (x, y) =>
      Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) <= PORTAL_MIN_SPAWN_DISTANCE,
  });
  if (!tile) return null;
  const data: PortalData = { target: spec.target, label: spec.label };
  return {
    id: spec.id,
    type: 'portal',
    name: spec.name,
    x: tile.x,
    y: tile.y,
    width: 1,
    height: 1,
    isBlocking: false,
    data,
  };
}

/**
 * Which map a space's preset id refers to, or null when the space has no such map.
 *
 * Presets are namespaced per space ("<spaceId>:race_track"); the namespaced copy wins. A map
 * stored under its bare id (the legacy default space) counts only when it belongs to the same
 * space. `lookup` returns the stored map for an id, or undefined.
 */
export function resolveSpaceMapId(
  spaceId: string,
  target: string,
  lookup: (id: string) => { spaceId?: string } | undefined,
): string | null {
  const namespaced = `${spaceId}:${target}`;
  if (lookup(namespaced)?.spaceId === spaceId) return namespaced;
  if (lookup(target)?.spaceId === spaceId) return target;
  return null;
}

/**
 * Which map a portal's `target` leads to, within `spaceId`. '@main' is the space's active map;
 * anything else is a preset id resolved by resolveSpaceMapId.
 */
export function resolvePortalTargetId(
  spaceId: string,
  activeMapId: string,
  target: string,
  lookup: (id: string) => { spaceId?: string } | undefined,
): string | null {
  if (target === PORTAL_MAIN_TARGET) {
    return lookup(activeMapId)?.spaceId === spaceId ? activeMapId : null;
  }
  return resolveSpaceMapId(spaceId, target, lookup);
}
