import type { GridMap } from '../types';

/**
 * Id of the private zone covering tile (x, y), or null if the tile is public.
 *
 * Explicit `map.privateZones` rectangles win. Otherwise each desk gets an automatic zone
 * (`desk_zone_<id>`) covering the desk's own tiles and the row directly below it, so a
 * user standing at the desk is in a zone and so is anyone in front of it.
 *
 * Shared by the server (presence / voice-zone bookkeeping) and the A* pathfinder (routes
 * avoid entering zones), so both agree on what counts as "in a zone".
 */
export function privateZoneIdAt(map: GridMap, x: number, y: number): string | null {
  // 1. Explicit private zones
  for (const zone of map.privateZones) {
    if (
      x >= zone.x &&
      x < zone.x + zone.width &&
      y >= zone.y &&
      y < zone.y + zone.height
    ) {
      return zone.id;
    }
  }
  // 2. Automatic private zone for 2x1 desks (lower 2x1 standing area y = desk.y + height, and desk tile itself)
  for (const obj of map.objects) {
    if (obj.type === "desk") {
      const deskW = obj.width || 2;
      const deskH = obj.height || 1;
      if (
        x >= obj.x &&
        x < obj.x + deskW &&
        (y === obj.y || y === obj.y + deskH)
      ) {
        return `desk_zone_${obj.id}`;
      }
    }
  }
  return null;
}
