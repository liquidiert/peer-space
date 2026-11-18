import { GridMap, TileType, MapObject, PrivateZone, Direction } from './types';
import { createGameState } from './lib/gameTable';

export function createDefaultOfficeMap(): GridMap {
  const width = 32;
  const height = 24;
  
  // Initialize floor tiles
  const tiles: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) {
      // Outer walls
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        row.push('wall_brick');
      } else if (y === 10 && x < 22 && x !== 10 && x !== 11) {
        // Divider wall between top office and lower lounge
        row.push('wall_wood');
      } else if (x >= 22 && y >= 12) {
        // Outdoor grass terrace
        row.push('floor_grass');
      } else if (x < 12 && y < 10) {
        // Meeting room tile
        row.push('floor_carpet');
      } else {
        // Main office wood floor
        row.push('floor_wood');
      }
    }
    tiles.push(row);
  }

  const privateZones: PrivateZone[] = [
    {
      id: 'zone_meeting_a',
      name: 'Meeting Room Alpha',
      color: 'rgba(59, 130, 246, 0.18)',
      x: 1,
      y: 1,
      width: 10,
      height: 8,
    },
    {
      id: 'zone_executive_lounge',
      name: 'Lounge & Arcade',
      color: 'rgba(168, 85, 247, 0.18)',
      x: 1,
      y: 11,
      width: 12,
      height: 11,
    },
    {
      id: 'zone_terrace',
      name: 'Outdoor Patio',
      color: 'rgba(34, 197, 94, 0.18)',
      x: 22,
      y: 12,
      width: 9,
      height: 10,
    }
  ];

  const objects: MapObject[] = [
    // Whiteboard in Meeting Room Alpha
    {
      id: 'wb_1',
      type: 'whiteboard',
      name: 'Alpha Whiteboard',
      x: 2,
      y: 1,
      width: 3,
      height: 1,
      isBlocking: true,
      data: {
        whiteboardStrokes: [],
      }
    },
    // Meeting Room Table & Chairs
    {
      id: "table_meeting",
      type: "conference_table",
      name: "Conference Table",
      x: 3,
      y: 4,
      width: 4,
      height: 2,
      isBlocking: true,
    },
    // Sticky note board
    {
      id: 'sticky_1',
      type: 'sticky_notes',
      name: 'Ideas Bulletin Board',
      x: 8,
      y: 1,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        notes: [
          {
            id: 'note_1',
            author: 'Alex',
            text: 'Welcome to PeerSpace! Use WASD to move and press E near objects!',
            color: '#fef08a',
            createdAt: Date.now() - 100000,
          },
          {
            id: 'note_2',
            author: 'Sarah',
            text: 'Proximity audio connects automatically when standing near coworkers.',
            color: '#bae6fd',
            createdAt: Date.now() - 50000,
          }
        ]
      }
    },
    // Workstation Desks in main area with claimable user desk states
    {
      id: 'desk_1',
      type: 'desk',
      name: 'Open Workstation 1',
      x: 14,
      y: 3,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 1',
          equipment: 'dual_monitors',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_2',
      type: 'desk',
      name: 'Open Workstation 2',
      x: 17,
      y: 3,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 2',
          equipment: 'designer_tablet',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_3',
      type: 'desk',
      name: 'Open Workstation 3',
      x: 14,
      y: 6,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 3',
          equipment: 'laptop',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_4',
      type: 'desk',
      name: 'Open Workstation 4',
      x: 17,
      y: 6,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Workstation 4',
          equipment: 'gaming_rig',
          stickyNotes: []
        }
      }
    },
    {
      id: 'desk_5',
      type: 'desk',
      name: 'Executive Corner Desk',
      x: 25,
      y: 7,
      width: 2,
      height: 1,
      isBlocking: true,
      data: {
        deskState: {
          deskLabel: 'Executive Suite Desk',
          statusNote: '☕ Open for 1-on-1 syncs & strategy discussions',
          equipment: 'dual_monitors',
          stickyNotes: []
        }
      }
    },
    
    // Plants for decoration
    { id: 'plant_1', type: 'plant', name: 'Monstera Plant', x: 12, y: 1, width: 1, height: 1, isBlocking: true },
    { id: 'plant_2', type: 'plant', name: 'Fiddle Leaf Fig', x: 21, y: 1, width: 1, height: 1, isBlocking: true },
    { id: 'plant_3', type: 'plant', name: 'Terrace Palm', x: 22, y: 12, width: 1, height: 1, isBlocking: true },

    // Arcade Game Table
    {
      id: 'game_1',
      type: 'game_table',
      name: 'Arcade Table',
      x: 6,
      y: 15,
      width: 2,
      height: 2,
      isBlocking: true,
      data: {
        gameState: createGameState()
      }
    },

    // Portal to the race track (walkable, outside every private zone, reachable from spawn)
    {
      id: 'portal_race_track',
      type: 'portal',
      name: 'Race track',
      x: 18,
      y: 14,
      width: 1,
      height: 1,
      isBlocking: false,
      data: { target: 'race_track', label: 'Race track' },
    },
  ];

  return {
    id: 'office_default',
    name: 'Tech Startup HQ',
    width,
    height,
    tiles,
    objects,
    privateZones,
    spawnPoint: { x: 15, y: 12 }
  };
}

export function createBeachRetreatMap(): GridMap {
  const width = 28;
  const height = 20;
  const tiles: TileType[][] = [];

  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        row.push('wall_brick');
      } else if (y > 14) {
        row.push('water');
      } else if (y > 8) {
        row.push('floor_concrete'); // sand
      } else {
        row.push('floor_wood'); // wooden dock/deck
      }
    }
    tiles.push(row);
  }

  return {
    id: 'beach_retreat',
    name: 'Beachside Deck',
    width,
    height,
    tiles,
    objects: [
      { id: "b_plant1", type: "plant", name: "Palm Tree", x: 2, y: 2, width: 2, height: 2, isBlocking: true },
      { id: "b_table1", type: "conference_table", name: "Conference Table", x: 8, y: 4, width: 3, height: 2, isBlocking: true },
      { id: 'b_wb1', type: 'whiteboard', name: 'Sunset Brainstorm', x: 15, y: 2, width: 3, height: 1, isBlocking: true, data: { whiteboardStrokes: [] } },
    ],
    privateZones: [
      { id: 'z_deck', name: 'Sun Deck Pod', color: 'rgba(234, 179, 8, 0.2)', x: 6, y: 2, width: 8, height: 6 }
    ],
    spawnPoint: { x: 14, y: 10 }
  };
}

/**
 * Race track geometry, in grid-corner coordinates (tile (x, y) is centred on x + 0.5). The
 * circuit is one closed loop: a rounded rectangle whose top straight has a hairpin hooking down
 * into the infield. The bottom straight is one uninterrupted run between its two corners.
 */
const RACE_TRACK_WIDTH = 88;
const RACE_TRACK_HEIGHT = 64;
/** Road tiles lie within this distance of the centre line: 3 tiles either side, 6 wide. */
const RACE_TRACK_ROAD_HALF_WIDTH = 3;
/** Centre-line extent of the straights (left, right, top, bottom). */
const TRACK_LEFT = 16;
const TRACK_RIGHT = 72;
const TRACK_TOP = 16;
const TRACK_BOTTOM = 48;
/** Radius of the four sweeping corners. */
const CORNER_RADIUS = 8;
/** Hairpin on the top straight: arms this far apart, tip this far into the infield. */
const HAIRPIN_X = 36;
const HAIRPIN_ARM_GAP = 12;
const HAIRPIN_DEPTH = 6;
/** Pit area off the track, above the top straight. Spawn and return portal sit inside it. */
const RACE_TRACK_PIT = { x: 30, y: 2, width: 20, height: 6 };
/**
 * Pit lane: the one gap in the tire barrier. A 4-wide strip of pit floor running from the bottom
 * of the pit down through the run-off to the top straight's road (which it meets at y = 13).
 */
const RACE_TRACK_PIT_LANE = { x: 32, y: 8, width: 4, height: 5 };
/**
 * Version of this preset. Stored tracks with an older (or no) version are rewritten on boot.
 * Bump whenever the layout changes.
 */
export const RACE_TRACK_VERSION = 5;

/** Points on an arc from angle `from` to `to` (radians; y grows downward on the grid). */
function arcPoints(
  cx: number, cy: number, r: number, from: number, to: number, steps: number,
): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return points;
}

/** Closed centre line, clockwise on screen, starting at the left straight's top. */
function raceTrackCentreLine(): [number, number][] {
  const r = CORNER_RADIUS;
  const L = TRACK_LEFT;
  const R = TRACK_RIGHT;
  const T = TRACK_TOP;
  const B = TRACK_BOTTOM;
  const h = HAIRPIN_X;
  const hr = HAIRPIN_ARM_GAP / 2;
  const quarter = Math.PI / 2;
  return [
    ...arcPoints(L + r, T + r, r, Math.PI, 1.5 * Math.PI, 6), // top-left corner
    [h, T],
    ...arcPoints(h + hr, T + HAIRPIN_DEPTH, hr, Math.PI, 0, 12), // hairpin tip
    [h + HAIRPIN_ARM_GAP, T],
    ...arcPoints(R - r, T + r, r, 1.5 * Math.PI, 2 * Math.PI, 6), // top-right corner
    ...arcPoints(R - r, B - r, r, 0, quarter, 6), // bottom-right corner
    ...arcPoints(L + r, B - r, r, quarter, Math.PI, 6), // bottom-left corner
  ];
}

const RACE_TRACK_CENTRE_LINE = raceTrackCentreLine();

function distanceToSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function isRaceTrackRoad(x: number, y: number): boolean {
  const px = x + 0.5;
  const py = y + 0.5;
  const n = RACE_TRACK_CENTRE_LINE.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = RACE_TRACK_CENTRE_LINE[i];
    const [bx, by] = RACE_TRACK_CENTRE_LINE[(i + 1) % n];
    if (distanceToSegment(px, py, ax, ay, bx, by) <= RACE_TRACK_ROAD_HALF_WIDTH) return true;
  }
  return false;
}

/**
 * Chebyshev distance from every tile to the nearest asphalt tile, by a BFS over the eight
 * neighbours (each step adds 1, so the BFS depth is the Chebyshev distance). -1 where no road.
 */
function distanceToRoad(tiles: TileType[][]): number[][] {
  const height = tiles.length;
  const width = tiles[0].length;
  const dist = tiles.map((row) => row.map(() => -1));
  const queue: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (tiles[y][x] === 'asphalt') {
        dist[y][x] = 0;
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
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || dist[ny][nx] !== -1) continue;
        dist[ny][nx] = dist[y][x] + 1;
        queue.push([nx, ny]);
      }
    }
  }
  return dist;
}

/**
 * The tire barrier: every grass tile at Chebyshev distance exactly 2 from the road. The road
 * edge is then one tile of run-off, then the barrier. Any step (4- or 8-way) changes the distance
 * by at most 1, so the barrier separates distance 1 from distance 3 with no diagonal leaks. The
 * pit lane is floor_tile, not grass, so it is never barriered; road, pit and walls are skipped too.
 */
function raceTrackBarrierTiles(tiles: TileType[][]): [number, number][] {
  const dist = distanceToRoad(tiles);
  const spots: [number, number][] = [];
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      if (tiles[y][x] === 'floor_grass' && dist[y][x] === 2) spots.push([x, y]);
    }
  }
  return spots;
}

/**
 * The start/finish line: a 1-wide object across the bottom straight at its midpoint, spanning the
 * road's full width. Read from the asphalt itself, so it always matches the road.
 */
function raceTrackFinishLine(tiles: TileType[][]): MapObject {
  const x = (TRACK_LEFT + TRACK_RIGHT) / 2; // midway along the bottom straight
  let top = TRACK_BOTTOM;
  while (tiles[top - 1]?.[x] === 'asphalt') top--;
  let bottom = TRACK_BOTTOM;
  while (tiles[bottom + 1]?.[x] === 'asphalt') bottom++;
  return {
    id: 'finish_line',
    type: 'finish_line',
    name: 'Start / Finish',
    x,
    y: top,
    width: 1,
    height: bottom - top + 1,
    isBlocking: false,
  };
}

/**
 * Direction arrows painted on the straights, one every ten tiles or so. Each straight runs
 * clockwise on screen: top east, right side south, bottom west, left side north. They sit on the
 * straights' centre-line rows and columns, clear of the hairpin arms, pit lane and finish line.
 */
const RACE_TRACK_ARROWS: { x: number; y: number; dir: Direction }[] = [
  { x: 26, y: 16, dir: 'right' },
  { x: 56, y: 16, dir: 'right' },
  { x: 72, y: 26, dir: 'down' },
  { x: 72, y: 36, dir: 'down' },
  { x: 34, y: 48, dir: 'left' },
  { x: 54, y: 48, dir: 'left' },
  { x: 16, y: 36, dir: 'up' },
  { x: 16, y: 26, dir: 'up' },
];

/**
 * The race track: a grass course with a closed six-wide asphalt circuit, a pit area off the
 * track (where users arrive) and a portal back to the space's main map. Karts are allowed.
 */
export function createRaceTrackMap(): GridMap {
  const width = RACE_TRACK_WIDTH;
  const height = RACE_TRACK_HEIGHT;
  const pit = RACE_TRACK_PIT;
  const lane = RACE_TRACK_PIT_LANE;
  const inRect = (r: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

  const tiles: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        row.push('wall_brick');
      } else if (inRect(pit, x, y) || inRect(lane, x, y)) {
        row.push('floor_tile');
      } else if (isRaceTrackRoad(x, y)) {
        row.push('asphalt');
      } else {
        row.push('floor_grass'); // offroad
      }
    }
    tiles.push(row);
  }

  const objects: MapObject[] = raceTrackBarrierTiles(tiles).map(([x, y], i) => ({
    id: `tires_${i + 1}`,
    type: 'tires' as const,
    name: 'Tire Barrier',
    x,
    y,
    width: 1,
    height: 1,
    isBlocking: true,
  }));
  objects.push(raceTrackFinishLine(tiles));
  RACE_TRACK_ARROWS.forEach((arrow, i) => {
    objects.push({
      id: `track_arrow_${i + 1}`,
      type: 'track_arrow',
      name: 'Track Direction',
      x: arrow.x,
      y: arrow.y,
      width: 1,
      height: 1,
      isBlocking: false,
      data: { dir: arrow.dir },
    });
  });
  objects.push({
    id: 'portal_main',
    type: 'portal',
    name: 'Back to the office',
    // Far end of the pit from spawn (Chebyshev distance 8), so arriving users don't step on it.
    x: pit.x + 12,
    y: pit.y + 2,
    width: 1,
    height: 1,
    isBlocking: false,
    data: { target: '@main', label: 'Back to the office' },
  });

  return {
    id: 'race_track',
    name: 'Race Track',
    width,
    height,
    tiles,
    objects,
    privateZones: [],
    spawnPoint: { x: pit.x + 4, y: pit.y + 2 },
    allowKarts: true,
    mapWideMedia: true,
    presetVersion: RACE_TRACK_VERSION,
  };
}

/**
 * Whether a stored race track predates the current preset and must be replaced on boot. The size
 * and the preset version are compared: a stored track with no version predates versioning. The
 * upgrade rewrites the whole map (id, space and name aside).
 */
export function needsRaceTrackUpgrade(map: GridMap): boolean {
  const preset = createRaceTrackMap();
  return (
    map.width !== preset.width ||
    map.height !== preset.height ||
    (map.presetVersion ?? 1) !== RACE_TRACK_VERSION
  );
}
