<script setup lang="ts">
// DEV ONLY: renders the real SpatialCanvas with a synthetic map and users so the pixel art can be
// screenshotted headlessly (see scripts/art-shot.mjs). Not linked from the app.
import { onMounted, ref } from 'vue';
import SpatialCanvas from '../components/SpatialCanvas.vue';
import type { AvatarCustomization, Direction, GridMap, MapObject, PresenceStatus, TileType, User } from '../types';
import type { KartModel } from '../lib/kartModels';
import { createGameState } from '../lib/gameTable';
import { AV_H, AV_W, drawAvatarHead, drawAvatarSprite } from '../lib/avatarSprite';

const WIDTH = 26;
const HEIGHT = 18;

function fill(tiles: TileType[][], x: number, y: number, w: number, h: number, tile: TileType) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) tiles[yy][xx] = tile;
  }
}

// Outer brick ring, grass everywhere else; zones are painted over it.
const tiles: TileType[][] = Array.from({ length: HEIGHT }, (_, y) =>
  Array.from({ length: WIDTH }, (_, x) =>
    x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1 ? 'wall_brick' : 'floor_grass',
  ) as TileType[],
);
// Top band: four indoor zones, with a wood partition between wood and carpet.
fill(tiles, 1, 1, 5, 5, 'floor_wood');
fill(tiles, 6, 1, 1, 5, 'wall_wood');
fill(tiles, 7, 1, 5, 5, 'floor_carpet');
fill(tiles, 12, 1, 5, 5, 'floor_tile');
fill(tiles, 17, 1, 8, 5, 'floor_concrete');
// Lower band: asphalt track on grass (kerbs on all four sides), water in the corner.
fill(tiles, 9, 9, 10, 5, 'asphalt');
fill(tiles, 21, 8, 4, 4, 'water');

const objects: MapObject[] = [
  // Wood room
  { id: 'desk_a', type: 'desk', name: 'Workstation A', x: 2, y: 2, width: 2, height: 1, isBlocking: true,
    data: { deskState: { deskLabel: 'Workstation A', equipment: 'dual_monitors' } } },
  { id: 'desk_b', type: 'desk', name: 'Workstation B', x: 4, y: 2, width: 2, height: 1, isBlocking: true,
    data: { deskState: { claimedByUserId: 'x', deskLabel: 'Workstation B', equipment: 'laptop' } } },
  { id: 'chair_a', type: 'chair', name: 'Chair', x: 2, y: 3, width: 1, height: 1, isBlocking: false },
  { id: 'computer_a', type: 'computer', name: 'Computer', x: 5, y: 4, width: 1, height: 1, isBlocking: true },
  // Carpet room
  { id: 'table_meeting', type: 'conference_table', name: 'Conference Table', x: 8, y: 2, width: 3, height: 2, isBlocking: true },
  { id: 'chair_b', type: 'chair', name: 'Chair', x: 8, y: 4, width: 1, height: 1, isBlocking: false },
  { id: 'plant_a', type: 'plant', name: 'Monstera Plant', x: 7, y: 1, width: 1, height: 1, isBlocking: true },
  // Tile room
  { id: 'wb_1', type: 'whiteboard', name: 'Alpha Whiteboard', x: 13, y: 1, width: 2, height: 1, isBlocking: true,
    data: { whiteboardStrokes: [] } },
  { id: 'sticky_1', type: 'sticky_notes', name: 'Ideas Bulletin Board', x: 12, y: 3, width: 2, height: 1, isBlocking: true,
    data: { notes: [] } },
  { id: 'game_1', type: 'game_table', name: 'Arcade Table', x: 14, y: 3, width: 2, height: 2, isBlocking: true,
    data: { gameState: createGameState() } },
  // Concrete room
  { id: 'shelf_1', type: 'bookshelf', name: 'Bookshelf', x: 18, y: 1, width: 2, height: 1, isBlocking: true },
  { id: 'door_1', type: 'door', name: 'Door', x: 21, y: 5, width: 1, height: 1, isBlocking: false },
  { id: 'plant_b', type: 'plant', name: 'Fiddle Leaf Fig', x: 24, y: 5, width: 1, height: 1, isBlocking: true },
  // Track dressing
  { id: 'tires_1', type: 'tires', name: 'Tire Barrier', x: 10, y: 8, width: 1, height: 1, isBlocking: true },
  { id: 'tires_2', type: 'tires', name: 'Tire Barrier', x: 11, y: 8, width: 1, height: 1, isBlocking: true },
  { id: 'tires_3', type: 'tires', name: 'Tire Barrier', x: 12, y: 8, width: 1, height: 1, isBlocking: true },
  { id: 'tires_4', type: 'tires', name: 'Tire Barrier', x: 13, y: 8, width: 1, height: 1, isBlocking: true },
  { id: 'finish_1', type: 'finish_line', name: 'Start / Finish', x: 14, y: 10, width: 1, height: 3, isBlocking: false },
  { id: 'arrow_right', type: 'track_arrow', name: 'Track Direction', x: 11, y: 11, width: 1, height: 1, isBlocking: false,
    data: { dir: 'right' } },
  { id: 'arrow_down', type: 'track_arrow', name: 'Track Direction', x: 17, y: 11, width: 1, height: 1, isBlocking: false,
    data: { dir: 'down' } },
  // Portal to the race track (the real map's '@main' target)
  { id: 'portal_1', type: 'portal', name: 'Race Track', x: 2, y: 14, width: 1, height: 1, isBlocking: false,
    data: { target: '@main', label: 'Race Track' } },
];

const currentMap: GridMap = {
  id: 'art_gallery',
  name: 'Art Gallery',
  width: WIDTH,
  height: HEIGHT,
  tiles,
  objects,
  privateZones: [],
  spawnPoint: { x: 2, y: 2 },
  allowKarts: true,
};

const MAP_ID = currentMap.id;

function avatar(
  skinColor: string,
  hairStyle: string,
  hairColor: string,
  outfitColor: string,
  glasses: boolean,
  hatStyle: string,
  statusEmoji: string,
): User['avatar'] {
  return { skinColor, hairStyle, hairColor, outfitColor, glasses, hatStyle, statusEmoji };
}

function baseUser(id: string, name: string, x: number, y: number, direction: User['direction'], a: User['avatar']): User {
  return {
    id,
    socketId: `sock-${id}`,
    name,
    position: { x, y },
    direction,
    avatar: a,
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    isScreenSharing: false,
    currentZoneId: null,
    lastSeen: Date.now(),
    presenceStatus: 'available',
    mapId: MAP_ID,
    kart: null,
  };
}

function kartUser(id: string, name: string, x: number, y: number, heading: number, model: KartModel, a: User['avatar'], boost = false): User {
  return {
    ...baseUser(id, name, x, y, 'right', a),
    kart: { heading, model, ...(boost ? { boost: true } : {}) },
  };
}

// Walking users: on floor tiles, one facing each direction.
const ada = baseUser('u-ada', 'Ada', 3, 4, 'down', avatar('#f0c19b', 'short', '#2b1a10', '#5b86cf', false, 'none', '💻'));
const linus = {
  ...baseUser('u-linus', 'Linus', 10, 4, 'up', avatar('#a66a41', 'curly', '#5a3a20', '#e79355', true, 'beanie', '🎧')),
  presenceStatus: 'busy' as const,
  isSpeaking: true,
};
const grace = {
  ...baseUser('u-grace', 'Grace', 16, 2, 'left', avatar('#e0a678', 'long', '#b5533a', '#9585d6', false, 'cap', '☕')),
  presenceStatus: 'dnd' as const,
};
const alan = baseUser('u-alan', 'Alan', 22, 3, 'right', avatar('#5a3520', 'bald', '#2b1a10', '#68b877', true, 'none', '🧠'));

// Karts: on the asphalt, fractional positions, one per model.
const karts: User[] = [
  kartUser('u-kart', 'Mae', 10.5, 10.5, 0, 'kart', avatar('#c8875a', 'afro', '#2b1a10', '#e0705f', false, 'none', '🚀')),
  kartUser('u-racer', 'Jules', 12.5, 11.5, Math.PI / 4, 'racer', avatar('#f8d9bd', 'short', '#d8b26a', '#54b8b4', false, 'none', '🔥'), true),
  kartUser('u-buggy', 'Nico', 16.5, 9.5, Math.PI / 2, 'buggy', avatar('#7d4b2e', 'curly', '#4a6fa5', '#e8c268', true, 'none', '⚡')),
  kartUser('u-drifter', 'Rosa', 11.5, 12.5, 2.4, 'drifter', avatar('#e0a678', 'long', '#6b7280', '#d67fa4', false, 'beanie', '✨')),
];

const users: User[] = [ada, linus, grace, alan, ...karts];
const currentUser = ada;

const localKart = null;

// --- Avatar sheet, above the map ------------------------------------------------------
// Every hairstyle, hat and glasses combination on the four facings, plus the walk cycle in
// profile, drawn with the same functions the map and the Studio use. Heads at the kart scale
// sit underneath. Light background on purpose: the ink outlines and the shadow vanish on slate.
const SHEET_SCALE = 4;
const SHEET_GUTTER = 110;
const SHEET_HEADER = 24;
const CELL_W = 96;
// The sprite box plus a gap, so one sprite's ground shadow never lands in the next row's top margin.
const CELL_H = AV_H * SHEET_SCALE + 24;
const HEAD_ROW_H = 84;
const SHEET_BG = '#dfe6f0';
const SHEET_INK = '#1e293b';
const SHEET_W = SHEET_GUTTER + 8 * CELL_W;
const SHEET_H = SHEET_HEADER + 7 * CELL_H + HEAD_ROW_H;

const SHEET_COLS: Array<{ label: string; direction: Direction; walkPhase: number }> = [
  { label: 'down', direction: 'down', walkPhase: -1 },
  { label: 'up', direction: 'up', walkPhase: -1 },
  { label: 'left', direction: 'left', walkPhase: -1 },
  { label: 'right', direction: 'right', walkPhase: -1 },
  { label: 'walk 0', direction: 'right', walkPhase: 0 },
  { label: 'walk 1', direction: 'right', walkPhase: 1 },
  { label: 'walk 2', direction: 'right', walkPhase: 2 },
  { label: 'walk 3', direction: 'right', walkPhase: 3 },
];

const SHEET_ROWS: Array<{ label: string; avatar: AvatarCustomization }> = [
  { label: 'short', avatar: { skinColor: '#f0c19b', hairColor: '#2b1a10', outfitColor: '#5b86cf', hairStyle: 'short', hatStyle: 'none', glasses: false, statusEmoji: '💻' } },
  { label: 'long', avatar: { skinColor: '#a66a41', hairColor: '#b5533a', outfitColor: '#e79355', hairStyle: 'long', hatStyle: 'none', glasses: false, statusEmoji: '🎧' } },
  { label: 'curly', avatar: { skinColor: '#e0a678', hairColor: '#5a3a20', outfitColor: '#68b877', hairStyle: 'curly', hatStyle: 'none', glasses: false, statusEmoji: '☕' } },
  { label: 'afro', avatar: { skinColor: '#7d4b2e', hairColor: '#2b1a10', outfitColor: '#9585d6', hairStyle: 'afro', hatStyle: 'none', glasses: false, statusEmoji: '🚀' } },
  { label: 'bald', avatar: { skinColor: '#f8d9bd', hairColor: '#6b7280', outfitColor: '#e0705f', hairStyle: 'bald', hatStyle: 'none', glasses: true, statusEmoji: '🧠' } },
  { label: 'cap', avatar: { skinColor: '#5a3520', hairColor: '#2b1a10', outfitColor: '#54b8b4', hairStyle: 'short', hatStyle: 'cap', glasses: false, statusEmoji: '🔥' } },
  { label: 'beanie+glasses', avatar: { skinColor: '#e8c0a0', hairColor: '#d8b26a', outfitColor: '#48506b', hairStyle: 'long', hatStyle: 'beanie', glasses: true, statusEmoji: '⚡' } },
];

/** Presence pip and status chip on a few cells, so their placement is checked per facing. */
function cellExtras(row: number, col: number): { presence: PresenceStatus | null; showEmoji: boolean } {
  if (row === 0 && col === 2) return { presence: 'dnd', showEmoji: true };
  if (row === 1 && col === 3) return { presence: 'busy', showEmoji: true };
  if (row === 6 && col === 2) return { presence: 'available', showEmoji: true };
  return { presence: null, showEmoji: false };
}

const HEAD_DIRECTIONS: Direction[] = ['down', 'left', 'up', 'right', 'down', 'left', 'up'];

const sheet = ref<HTMLCanvasElement | null>(null);

function drawSheet() {
  const canvas = sheet.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = SHEET_BG;
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);
  ctx.fillStyle = SHEET_INK;
  ctx.font = '13px sans-serif';
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'center';
  SHEET_COLS.forEach((col, c) => {
    ctx.fillText(col.label, SHEET_GUTTER + c * CELL_W + CELL_W / 2, SHEET_HEADER / 2);
  });

  SHEET_ROWS.forEach((row, r) => {
    const top = SHEET_HEADER + r * CELL_H;
    ctx.textAlign = 'left';
    ctx.fillText(row.label, 8, top + CELL_H / 2);
    SHEET_COLS.forEach((col, c) => {
      const ox = SHEET_GUTTER + c * CELL_W + (CELL_W - AV_W * SHEET_SCALE) / 2;
      const oy = top + 8;
      drawAvatarSprite(ctx, ox, oy, SHEET_SCALE, row.avatar, {
        direction: col.direction,
        walkPhase: col.walkPhase,
        ...cellExtras(r, c),
      });
    });
  });

  // Heads at the kart scale, one per row, facing a mix of directions.
  const headTop = SHEET_HEADER + SHEET_ROWS.length * CELL_H;
  ctx.textAlign = 'left';
  ctx.fillText('heads x2', 8, headTop + HEAD_ROW_H / 2);
  SHEET_ROWS.forEach((row, r) => {
    drawAvatarHead(ctx, SHEET_GUTTER + r * CELL_W + CELL_W / 2, headTop + HEAD_ROW_H / 2, 2, row.avatar, {
      direction: HEAD_DIRECTIONS[r],
    });
  });
}

onMounted(drawSheet);
</script>

<template>
  <div class="art-gallery-sheet" style="padding: 0 0 0 8px; background: #dfe6f0; width: fit-content;">
    <canvas ref="sheet" :width="SHEET_W" :height="SHEET_H" style="display: block;" />
  </div>
  <div class="art-gallery" style="width: 1400px; height: 1000px; position: relative; overflow: hidden;">
    <SpatialCanvas
      :current-user="currentUser"
      :users="users"
      :current-map="currentMap"
      :builder-mode="false"
      builder-action="place"
      selected-tile="floor_wood"
      :selected-object="null"
      :local-kart="localKart"
      style="width: 100%; height: 100%;"
    />
  </div>
</template>
