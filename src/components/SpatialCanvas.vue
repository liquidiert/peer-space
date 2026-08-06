<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import type { User, GridMap, MapObject, TileType } from '../types';
import { ACCENT, mixHex, type Ramp } from '../lib/pixelArt';
import { AV_H, AV_INK as AVATAR_INK, AV_W, drawAvatarSprite } from '../lib/avatarSprite';

const props = defineProps<{
  currentUser: User;
  users: User[];
  currentMap: GridMap;
  builderMode: boolean;
  builderAction: 'place' | 'erase';
  selectedTile: TileType;
  selectedObject: MapObject | null;
}>();

const emit = defineEmits<{
  (e: 'move', payload: { x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; ghost?: boolean }): void;
  (e: 'navigateTile', payload: { x: number; y: number }): void;
  (e: 'interactObject', object: MapObject): void;
  (e: 'placeObject', newObj: MapObject): void;
  (e: 'removeObject', objectId: string): void;
  (e: 'changeTile', payload: { x: number; y: number; tileType: TileType }): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const scrollContainerRef = ref<HTMLDivElement | null>(null);
const CELL_SIZE = 48; // Each spatial tile is 48x48px

// Ghost Mode: holding "g" lets you walk through other users. The server is still the
// authority on collision (see server.ts user:move), this just flags the request.
const isGhostMode = ref(false);

// Mobile camera-follow: on small/touch screens the map is larger than the
// viewport, so we auto-scroll the container to keep the player's avatar centered.
const isMobile = ref(false);
function updateIsMobile() {
  isMobile.value = window.matchMedia('(max-width: 768px)').matches;
}

function followCameraOnMobile() {
  if (!isMobile.value) return;
  const container = scrollContainerRef.value;
  if (!container) return;

  const displayPos = displayPosMap.get(props.currentUser.socketId);
  const tileX = displayPos?.x ?? props.currentUser.position?.x ?? 0;
  const tileY = displayPos?.y ?? props.currentUser.position?.y ?? 0;
  const px = (tileX + 0.5) * CELL_SIZE;
  const py = (tileY + 0.5) * CELL_SIZE;

  container.scrollTo({
    left: px - container.clientWidth / 2,
    top: py - container.clientHeight / 2,
    behavior: 'auto',
  });
}

// ============================================================================
// Cel-Shaded Pixel Art Toolkit
// ============================================================================
// Every tile and object is authored on a virtual 16x16 grid per cell (PX screen
// pixels per art pixel), so nothing lands on a half-pixel and the whole map
// stays crisp. Shading follows one convention everywhere: a hard OUTLINE edge,
// a mid `base` tone, `dark` on the bottom/right (facing away from the light)
// and `light`/`hi` on the top/left, using flat bands and dithering rather than
// gradients - that combination is what reads as "cel-shaded" instead of muddy.

const ART = 16; // art pixels per tile edge
const PX = CELL_SIZE / ART; // screen pixels per art pixel
const OUTLINE = '#0f172a';


/**
 * Terrain ramps.
 *
 * Two things separate these from a classic tileset palette. First, the ramps are
 * *hue-shifted* rather than just darkened - shadows rotate toward blue, highlights
 * toward warm yellow - which is what stops large flat areas reading as dead grey/brown.
 * Second, every material carries a `tones` triplet within roughly one step of `base`:
 * that variation is applied per plank / per slab so the surface has life without any
 * single pixel standing out.
 *
 * Kept separate from PALETTE (which objects use) so retuning the ground doesn't silently
 * restyle every desk and chair on the map.
 */
interface TileRamp extends Ramp {
  /** Deeper than `dark` - seams, mortar and contact shadow only. */
  shadow: string;
  tones: [string, string, string];
}

const TILE: Record<string, TileRamp> = {
  oak: {
    shadow: '#5c452f',
    dark: '#87603e',
    base: '#ad8058',
    light: '#c69a72',
    hi: '#e2c096',
    tones: ['#a87b54', '#ad8058', '#b3865e'],
  },
  carpet: {
    shadow: '#3a4560',
    dark: '#4e5b7a',
    base: '#647293',
    light: '#7986a8',
    hi: '#9ba7c4',
    tones: ['#616f90', '#647293', '#687598'],
  },
  // Warm off-white, not paper-white: a floor this bright pulls focus from everything
  // standing on it, and the grout is a mid grey so the joints read as lines rather than
  // as a black grid drawn over the room.
  ceramic: {
    shadow: '#a3acb9',
    dark: '#bcc5cf',
    base: '#d6dde4',
    light: '#e8edf1',
    hi: '#fbfdfe',
    tones: ['#d1d8e0', '#d6dde4', '#dae1e8'],
  },
  grass: {
    shadow: '#365a2c',
    dark: '#4c7539',
    base: '#639247',
    light: '#7cad57',
    hi: '#a1cd74',
    tones: ['#608e45', '#639247', '#66964a'],
  },
  concrete: {
    shadow: '#575d66',
    dark: '#727882',
    base: '#8d939c',
    light: '#a3a9b2',
    hi: '#c0c6ce',
    tones: ['#8a9099', '#8d939c', '#90969f'],
  },
  // Terracotta rather than fire-engine red: the outer wall rings the whole map, so a
  // saturated hue there fights everything inside it for attention.
  brick: {
    shadow: '#68372e',
    dark: '#9b4f3e',
    base: '#c06a51',
    light: '#d78563',
    hi: '#eaa985',
    tones: ['#bb6650', '#c06a51', '#c67056'],
  },
  plank: {
    shadow: '#3f2915',
    dark: '#6a4222',
    base: '#8d5a2e',
    light: '#ac753f',
    hi: '#cb9a5f',
    tones: ['#885628', '#8d5a2e', '#925f33'],
  },
  water: {
    shadow: '#16536e',
    dark: '#1f7096',
    base: '#2c9ac2',
    light: '#4cbcd9',
    hi: '#a5e7f3',
    tones: ['#2a94bb', '#2c9ac2', '#2ea0c9'],
  },
};

/**
 * Object ramps - furniture, props and screens.
 *
 * Same hue-shifting rule as the terrain: shadows rotate cool, highlights rotate warm.
 * Deliberately a step or two off full saturation, because objects sit *on* the floor and a
 * pure hue at this size stops reading as a lit material and starts reading as a flat decal.
 */
const PALETTE: Record<string, Ramp> = {
  oak: { dark: '#8a6340', base: '#b08258', light: '#c99c72', hi: '#e3c095' },
  carpet: { dark: '#4e5b7a', base: '#647293', light: '#7986a8', hi: '#9ba7c4' },
  marble: { dark: '#aeb8c4', base: '#e4e9ee', light: '#f2f5f8', hi: '#ffffff' },
  grass: { dark: '#4c7539', base: '#639247', light: '#7cad57', hi: '#a1cd74' },
  concrete: { dark: '#727882', base: '#8d939c', light: '#a3a9b2', hi: '#c0c6ce' },
  brick: { dark: '#9b4f3e', base: '#c06a51', light: '#d78563', hi: '#eaa985' },
  darkwood: { dark: '#5a3a20', base: '#7d532e', light: '#9c6c41', hi: '#bd8f60' },
  water: { dark: '#245f80', base: '#3287ac', light: '#4fadcd', hi: '#96dcec' },
  steel: { dark: '#4d5972', base: '#78849b', light: '#9ea9bd', hi: '#cfd6e2' },
  indigo: { dark: '#4a4a86', base: '#6f6dae', light: '#8b8ac6', hi: '#b6b5e0' },
  amber: { dark: '#a8712c', base: '#d29a45', light: '#e5b565', hi: '#f5d99a' },
  leaf: { dark: '#3a7346', base: '#549a5f', light: '#71b878', hi: '#a5d9a5' },
};

/** Stable pseudo-random in [0,1) for a grid cell - deterministic so texture never flickers. */
function tileHash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Fill a rect in art-pixel units relative to an origin. */
function fx(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
) {
  ctx.fillStyle = color;
  ctx.fillRect(ox + x * PX, oy + y * PX, w * PX, h * PX);
}

/** 1-art-pixel-thick outline rect (drawn as 4 fills so it stays perfectly crisp). */
function ox1(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
) {
  fx(ctx, ox, oy, x, y, w, 1, color);
  fx(ctx, ox, oy, x, y + h - 1, w, 1, color);
  fx(ctx, ox, oy, x, y, 1, h, color);
  fx(ctx, ox, oy, x + w - 1, y, 1, h, color);
}

/** Checkerboard dithering - the pixel-art stand-in for a gradient/soft texture. */
function dither(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  parity = 0
) {
  ctx.fillStyle = color;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if ((i + j) % 2 === parity) {
        ctx.fillRect(ox + (x + i) * PX, oy + (y + j) * PX, PX, PX);
      }
    }
  }
}

/** A solid block with cel shading: light top/left edge, dark bottom/right edge. */
function shadedBlock(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  w: number,
  h: number,
  ramp: Ramp,
  outlined = true
) {
  fx(ctx, ox, oy, x, y, w, h, ramp.base);
  fx(ctx, ox, oy, x, y, w, 1, ramp.light); // top highlight
  fx(ctx, ox, oy, x, y, 1, h, ramp.light); // left highlight
  fx(ctx, ox, oy, x, y + h - 1, w, 1, ramp.dark); // bottom shadow
  fx(ctx, ox, oy, x + w - 1, y, 1, h, ramp.dark); // right shadow
  if (outlined) ox1(ctx, ox, oy, x, y, w, h, OUTLINE);
}

// ============================================================================
// Tiles
// ============================================================================
// Tile art is authored in *world* art-pixel space, not per-cell: plank runs, brick
// courses and slab grids are all derived from (x * ART + i), so a pattern flows straight
// across cell boundaries instead of restarting at each one. That is the single biggest
// difference between this and a stamped tileset - without it the 48px grid reads as a
// visible checkerboard no matter how good each individual cell looks, which is exactly
// what made the old floor read as masonry.
//
// Contrast is spent on edges, not on surfaces. Floors cover most of the screen, so their
// interiors stay deliberately quiet (low-contrast tones, sparse detail) and the strong
// values go into contact shadows where walls meet the floor and into material
// transitions - the cues that make a scene look lit rather than merely patterned.

/** Deep neutral used for ambient occlusion, always applied translucently. */
const AO = '#0b1220';

function isWallTile(t?: TileType) {
  return t === 'wall_brick' || t === 'wall_wood';
}

/** Translucent fill in art-pixel units - the soft-step counterpart to `fx`. */
function fxa(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  fx(ctx, ox, oy, x, y, w, h, color);
  ctx.restore();
}

/** Pick a per-feature tone (per plank, per slab, ...) that stays within a step of base. */
function tone(ramp: TileRamp, seed: number) {
  return ramp.tones[Math.floor(seed * ramp.tones.length) % ramp.tones.length];
}

/**
 * Contact shadow where a floor cell abuts a wall. Walls are drawn as solid blocks seen
 * from above, so without this they look pasted onto the floor rather than standing on it.
 * The light sits top-left, so the band below a wall is the widest and softest, and the
 * other three sides get progressively tighter.
 */
function floorContactShadow(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  tiles: TileType[][]
) {
  const at = (dx: number, dy: number) => tiles[y + dy]?.[x + dx];

  if (isWallTile(at(0, -1))) {
    fxa(ctx, ox, oy, 0, 0, ART, 2, AO, 0.3);
    fxa(ctx, ox, oy, 0, 2, ART, 2, AO, 0.14);
  }
  if (isWallTile(at(-1, 0))) {
    fxa(ctx, ox, oy, 0, 0, 2, ART, AO, 0.26);
    fxa(ctx, ox, oy, 2, 0, 1, ART, AO, 0.12);
  }
  if (isWallTile(at(1, 0))) fxa(ctx, ox, oy, ART - 1, 0, 1, ART, AO, 0.16);
  if (isWallTile(at(0, 1))) fxa(ctx, ox, oy, 0, ART - 1, ART, 1, AO, 0.16);

  // Inner corners pool a little more darkness, the way real ambient occlusion does.
  if (isWallTile(at(0, -1)) && isWallTile(at(-1, 0))) fxa(ctx, ox, oy, 0, 0, 4, 4, AO, 0.16);
  if (isWallTile(at(0, -1)) && isWallTile(at(1, 0))) fxa(ctx, ox, oy, ART - 4, 0, 4, 4, AO, 0.12);
}

function renderTile(
  ctx: CanvasRenderingContext2D,
  type: TileType,
  x: number,
  y: number,
  tiles: TileType[][]
) {
  const ox = x * CELL_SIZE;
  const oy = y * CELL_SIZE;

  switch (type) {
    case 'floor_wood': {
      const p = TILE.oak;
      // 5 art pixels per board - deliberately not a divisor of 16, so boards straddle
      // cell edges and the seams never line up into a grid.
      const PLANK_H = 5;
      const firstPlank = Math.floor((y * ART) / PLANK_H);
      const lastPlank = Math.floor((y * ART + ART - 1) / PLANK_H);

      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        const plank = Math.floor(worldRow / PLANK_H);
        const rowInPlank = worldRow - plank * PLANK_H;
        const board =
          rowInPlank === 0 ? p.light : rowInPlank === PLANK_H - 1 ? p.dark : tone(p, tileHash(0, plank, 3));
        fx(ctx, ox, oy, 0, j, ART, 1, board);
      }

      for (let plank = firstPlank; plank <= lastPlank; plank++) {
        const top = plank * PLANK_H - y * ART;

        // Every board is cut to its own length and phase, so butt joints scatter instead
        // of stacking into the brick-like courses the old per-cell joint produced. Boards
        // are 4-8 cells long: short boards put a joint in view every couple of cells, which
        // is exactly the regular speckle that reads as masonry rather than a timber floor.
        const period = 64 + Math.floor(tileHash(0, plank, 7) * 64);
        const phase = Math.floor(tileHash(0, plank, 8) * period);
        for (let i = 0; i < ART; i++) {
          const worldCol = x * ART + i;
          if ((((worldCol - phase) % period) + period) % period !== 0) continue;
          for (let k = 0; k < PLANK_H - 1; k++) {
            const j = top + k;
            if (j < 0 || j >= ART) continue;
            // The cut itself plus the lit end-grain of the next board along, so a joint
            // reads as two boards meeting rather than as a scratch on one.
            fxa(ctx, ox, oy, i, j, 1, 1, p.shadow, 0.55);
            if (i + 1 < ART) fxa(ctx, ox, oy, i + 1, j, 1, 1, p.hi, 0.16);
          }
        }

        // Grain: two short dashes per board per cell, one darker one lighter. Short and
        // low-contrast on purpose - grain that reads individually turns a floor into noise.
        for (let g = 0; g < 2; g++) {
          const gy = top + 1 + Math.floor(tileHash(x, plank, 50 + g) * (PLANK_H - 2));
          if (gy < 0 || gy >= ART) continue;
          const gx = Math.floor(tileHash(x, plank, 40 + g) * 11);
          const gw = 3 + Math.floor(tileHash(x, plank, 60 + g) * 4);
          fxa(ctx, ox, oy, gx, gy, gw, 1, g === 0 ? p.shadow : p.hi, 0.18);
        }

        // A knot every dozen boards or so - the rare detail the eye reads as "real wood".
        if (tileHash(x, plank, 91) > 0.94) {
          const ky = top + 1 + Math.floor(tileHash(x, plank, 92) * (PLANK_H - 3));
          const kx = 2 + Math.floor(tileHash(x, plank, 93) * 11);
          if (ky >= 0 && ky + 1 < ART) {
            fxa(ctx, ox, oy, kx, ky, 3, 2, p.shadow, 0.5);
            fxa(ctx, ox, oy, kx + 1, ky, 1, 1, p.dark, 0.8);
          }
        }
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_carpet': {
      const p = TILE.carpet;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Broad, soft mottling on a 4px world grid: the low-frequency variation that makes a
      // large carpeted room feel like fabric under uneven light rather than a flat fill.
      for (let j = 0; j < ART; j += 4) {
        for (let i = 0; i < ART; i += 4) {
          const wx = (x * ART + i) >> 2;
          const wy = (y * ART + j) >> 2;
          const h = tileHash(wx, wy, 12);
          fx(ctx, ox, oy, i, j, 4, 4, tone(p, h));
          // Broad pressure marks, the way a real carpet shows where the pile has been
          // walked flat - the low-frequency variation a flat fill can never have.
          if (h > 0.92) fxa(ctx, ox, oy, i, j, 4, 4, p.light, 0.28);
          else if (h < 0.08) fxa(ctx, ox, oy, i, j, 4, 4, p.shadow, 0.2);
        }
      }

      // Loop pile, as a fine translucent rib rather than hard dither pixels - at 3 screen
      // pixels per art pixel, hard dithering over an area this large buzzes. The paired
      // light-over-shadow rows are what give the surface a nap; a single flat tone here
      // was the difference between "carpet" and "blue rectangle".
      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        const phase = worldRow % 3;
        if (phase === 2) continue;
        for (let i = (worldRow >> 1) % 2; i < ART; i += 2) {
          fxa(ctx, ox, oy, i, j, 1, 1, phase === 0 ? p.hi : p.shadow, phase === 0 ? 0.22 : 0.14);
        }
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_tile': {
      const p = TILE.ceramic;
      // Large-format slabs on a 12px world grid: bigger than a cell is wide (16 art px
      // would re-align the pattern to the cell grid, 8 gave four fussy squares per cell),
      // so grout lines run the length of a room and drift across cell boundaries.
      const SLAB = 12;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        const inY = worldRow % SLAB;
        for (let i = 0; i < ART; i++) {
          const worldCol = x * ART + i;
          const inX = worldCol % SLAB;
          const sx = Math.floor(worldCol / SLAB);
          const sy = Math.floor(worldRow / SLAB);

          if (inX === 0 || inY === 0) {
            fx(ctx, ox, oy, i, j, 1, 1, p.shadow); // grout
            continue;
          }

          fx(ctx, ox, oy, i, j, 1, 1, tone(p, tileHash(sx, sy, 21)));

          // Bevels are translucent so the slab edge is a soft turn of the surface rather
          // than an inked border - at full strength every slab wore a bright white L and
          // the floor glared.
          if (inX === 1 || inY === 1) fxa(ctx, ox, oy, i, j, 1, 1, p.light, 0.55);
          else if (inX === SLAB - 1 || inY === SLAB - 1) fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.45);
          // Faint veining, so a big expanse of stone isn't a field of identical squares.
          else if (((worldCol * 3 + worldRow * 5) % 29) === Math.floor(tileHash(sx, sy, 23) * 29)) {
            fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.3);
          }
        }
      }

      // A specular streak on roughly one slab in six - polished stone reads by its
      // highlights, but giving every slab one would look like a printed pattern.
      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        if (worldRow % SLAB !== 4) continue;
        for (let i = 0; i < ART; i++) {
          const worldCol = x * ART + i;
          if (worldCol % SLAB !== 3) continue;
          const sx = Math.floor(worldCol / SLAB);
          const sy = Math.floor(worldRow / SLAB);
          if (tileHash(sx, sy, 22) < 0.8) continue;
          fxa(ctx, ox, oy, i, j, Math.min(4, ART - i), 1, p.hi, 0.5);
          if (j + 1 < ART) fxa(ctx, ox, oy, i + 1, j + 1, Math.min(2, ART - i - 1), 1, p.hi, 0.25);
        }
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_grass': {
      const p = TILE.grass;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Patchiness first, on a coarse world grid, so the lawn has large soft areas of
      // lighter and darker growth instead of uniform green.
      for (let j = 0; j < ART; j += 4) {
        for (let i = 0; i < ART; i += 4) {
          const wx = (x * ART + i) >> 2;
          const wy = (y * ART + j) >> 2;
          const h = tileHash(wx, wy, 31);
          fx(ctx, ox, oy, i, j, 4, 4, tone(p, h));
          // Occasional patch of thicker or thinner growth. Rare and translucent: at full
          // strength every fourth block came out a different green and the lawn read as
          // camouflage rather than grass.
          if (h > 0.93) fxa(ctx, ox, oy, i, j, 4, 4, p.light, 0.5);
          else if (h < 0.07) fxa(ctx, ox, oy, i, j, 4, 4, p.shadow, 0.3);
        }
      }

      // Blades: a lit stroke over its own shadow, which is what gives each tuft volume
      // instead of looking like scattered confetti.
      const blades = 3 + Math.floor(tileHash(x, y, 1) * 3);
      for (let i = 0; i < blades; i++) {
        const bx = 1 + Math.floor(tileHash(x, y, 10 + i) * 13);
        const by = 2 + Math.floor(tileHash(x, y, 20 + i) * 11);
        fxa(ctx, ox, oy, bx, by, 1, 3, p.shadow, 0.45);
        fxa(ctx, ox, oy, bx, by - 1, 1, 3, p.light, 0.85);
        fxa(ctx, ox, oy, bx, by - 1, 1, 1, p.hi, 0.7);
      }

      // Wildflowers are punctuation - one every dozen or so cells. Any more often and the
      // eye starts reading the speckle instead of the space.
      if (tileHash(x, y, 77) > 0.94) {
        const fxp = 2 + Math.floor(tileHash(x, y, 78) * 12);
        const fyp = 2 + Math.floor(tileHash(x, y, 79) * 12);
        fx(ctx, ox, oy, fxp, fyp, 2, 2, '#e8d18a');
        fx(ctx, ox, oy, fxp, fyp, 1, 1, '#fbf0c8');
        fx(ctx, ox, oy, fxp + 1, fyp + 1, 1, 1, '#c39a4a');
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_concrete': {
      const p = TILE.concrete;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      for (let j = 0; j < ART; j += 4) {
        for (let i = 0; i < ART; i += 4) {
          const wx = (x * ART + i) >> 2;
          const wy = (y * ART + j) >> 2;
          fx(ctx, ox, oy, i, j, 4, 4, tone(p, tileHash(wx, wy, 41)));
        }
      }

      // Expansion joints every 3 cells in world space - a scored line with a lit lower lip,
      // so it reads as a cut into the slab rather than a drawn-on stripe.
      for (let i = 0; i < ART; i++) {
        if ((x * ART + i) % (ART * 3) !== 0) continue;
        fx(ctx, ox, oy, i, 0, 1, ART, p.shadow);
        if (i + 1 < ART) fxa(ctx, ox, oy, i + 1, 0, 1, ART, p.hi, 0.25);
      }
      for (let j = 0; j < ART; j++) {
        if ((y * ART + j) % (ART * 3) !== 0) continue;
        fx(ctx, ox, oy, 0, j, ART, 1, p.shadow);
        if (j + 1 < ART) fxa(ctx, ox, oy, 0, j + 1, ART, 1, p.hi, 0.25);
      }

      const specks = Math.floor(tileHash(x, y, 5) * 5);
      for (let i = 0; i < specks; i++) {
        const sx = 1 + Math.floor(tileHash(x, y, 30 + i) * 14);
        const sy = 1 + Math.floor(tileHash(x, y, 40 + i) * 14);
        fxa(ctx, ox, oy, sx, sy, 1, 1, i % 2 ? p.hi : p.shadow, 0.35);
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'wall_brick': {
      const p = TILE.brick;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.shadow); // mortar

      // Courses run in world space: 4px high, half-brick stagger per course, so a wall
      // reads as one continuous run of masonry however long it is.
      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        const course = Math.floor(worldRow / 4);
        const rowInCourse = worldRow - course * 4;
        if (rowInCourse === 3) continue; // mortar bed between courses

        for (let i = 0; i < ART; i++) {
          const worldCol = x * ART + i;
          const shifted = worldCol + (course % 2 ? 4 : 0);
          if (shifted % 8 === 7) continue; // head joint between bricks
          const brick = Math.floor(shifted / 8);
          fx(
            ctx,
            ox,
            oy,
            i,
            j,
            1,
            1,
            rowInCourse === 0 ? p.light : rowInCourse === 2 ? p.dark : tone(p, tileHash(brick, course, 51))
          );
        }
      }

      // The lit top face only exists where the wall actually ends - capping every cell
      // (as before) painted a bright stripe through the middle of every wall run.
      if (!isWallTile(tiles[y - 1]?.[x])) {
        fx(ctx, ox, oy, 0, 0, ART, 2, p.hi);
        fx(ctx, ox, oy, 0, 2, ART, 1, p.light);
      }
      // Base line where the block meets whatever is below it.
      if (!isWallTile(tiles[y + 1]?.[x])) fx(ctx, ox, oy, 0, ART - 1, ART, 1, p.shadow);
      // Outline only along exposed edges, so long walls don't get sliced into cells.
      if (!isWallTile(tiles[y - 1]?.[x])) fx(ctx, ox, oy, 0, 0, ART, 1, OUTLINE);
      if (!isWallTile(tiles[y + 1]?.[x])) fx(ctx, ox, oy, 0, ART - 1, ART, 1, OUTLINE);
      if (!isWallTile(tiles[y]?.[x - 1])) fx(ctx, ox, oy, 0, 0, 1, ART, OUTLINE);
      if (!isWallTile(tiles[y]?.[x + 1])) fx(ctx, ox, oy, ART - 1, 0, 1, ART, OUTLINE);
      break;
    }

    case 'wall_wood': {
      const p = TILE.plank;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Vertical boarding, 5px wide in world space (again not a divisor of 16) with a lit
      // left edge and a shaded right edge per board.
      for (let i = 0; i < ART; i++) {
        const worldCol = x * ART + i;
        const board = Math.floor(worldCol / 5);
        const colInBoard = worldCol - board * 5;
        fx(
          ctx,
          ox,
          oy,
          i,
          0,
          1,
          ART,
          colInBoard === 0 ? p.light : colInBoard === 4 ? p.shadow : tone(p, tileHash(board, 0, 61))
        );
      }

      // Cross rail, aligned to the world so it runs unbroken along the whole partition.
      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        const inRail = ((worldRow % ART) + ART) % ART;
        if (inRail === 6) fx(ctx, ox, oy, 0, j, ART, 1, p.hi);
        else if (inRail === 7) fx(ctx, ox, oy, 0, j, ART, 1, p.light);
        else if (inRail === 8) fx(ctx, ox, oy, 0, j, ART, 1, p.shadow);
      }
      // Nail heads sit on the rail, one per board.
      for (let i = 0; i < ART; i++) {
        const worldCol = x * ART + i;
        if (worldCol % 5 !== 2) continue;
        const railRow = 7 - (y * ART) % ART;
        if (railRow >= 0 && railRow < ART) fxa(ctx, ox, oy, i, railRow, 1, 1, p.shadow, 0.7);
      }

      if (!isWallTile(tiles[y - 1]?.[x])) {
        fx(ctx, ox, oy, 0, 0, ART, 2, p.hi);
        fx(ctx, ox, oy, 0, 0, ART, 1, OUTLINE);
      }
      if (!isWallTile(tiles[y + 1]?.[x])) {
        fx(ctx, ox, oy, 0, ART - 1, ART, 1, OUTLINE);
      }
      if (!isWallTile(tiles[y]?.[x - 1])) fx(ctx, ox, oy, 0, 0, 1, ART, OUTLINE);
      if (!isWallTile(tiles[y]?.[x + 1])) fx(ctx, ox, oy, ART - 1, 0, 1, ART, OUTLINE);
      break;
    }

    case 'water': {
      const p = TILE.water;
      // Depth: shallower (lighter) the closer a cell is to a non-water neighbour, which is
      // what makes a body of water read as having a bottom instead of being a blue rectangle.
      const nearShore =
        tiles[y - 1]?.[x] !== 'water' ||
        tiles[y + 1]?.[x] !== 'water' ||
        tiles[y]?.[x - 1] !== 'water' ||
        tiles[y]?.[x + 1] !== 'water';
      fx(ctx, ox, oy, 0, 0, ART, ART, nearShore ? p.light : p.base);

      for (let j = 0; j < ART; j += 4) {
        for (let i = 0; i < ART; i += 4) {
          const wx = (x * ART + i) >> 2;
          const wy = (y * ART + j) >> 2;
          if (tileHash(wx, wy, 71) > 0.7) fxa(ctx, ox, oy, i, j, 4, 4, p.dark, 0.35);
        }
      }

      // Foam where the water meets land, fading out over three pixels rather than stopping
      // dead - a hard band of highlight along the shore reads as a drawing error.
      if (tiles[y - 1]?.[x] !== undefined && tiles[y - 1]?.[x] !== 'water') {
        fxa(ctx, ox, oy, 0, 0, ART, 1, p.hi, 0.55);
        fxa(ctx, ox, oy, 0, 1, ART, 1, p.hi, 0.3);
        dither(ctx, ox, oy, 0, 2, ART, 2, p.light, (x + y) % 2);
      }
      if (tiles[y + 1]?.[x] !== undefined && tiles[y + 1]?.[x] !== 'water') {
        fxa(ctx, ox, oy, 0, ART - 1, ART, 1, p.hi, 0.35);
      }
      if (tiles[y]?.[x - 1] !== undefined && tiles[y]?.[x - 1] !== 'water') {
        fxa(ctx, ox, oy, 0, 0, 1, ART, p.hi, 0.35);
      }
      if (tiles[y]?.[x + 1] !== undefined && tiles[y]?.[x + 1] !== 'water') {
        fxa(ctx, ox, oy, ART - 1, 0, 1, ART, p.hi, 0.35);
      }
      break;
    }
  }
}

/**
 * The moving part of water, drawn per frame on top of the cached terrain (see below).
 * Kept separate from renderTile precisely so the expensive static art can be cached.
 */
function renderWaterAnimation(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const ox = x * CELL_SIZE;
  const oy = y * CELL_SIZE;
  const p = TILE.water;

  // Quantised to art pixels and to a ~4Hz step so the ripples stay chunky pixel art
  // instead of sliding smoothly like a shader.
  const t = Math.floor(Date.now() / 260);
  for (let i = 0; i < 3; i++) {
    const seed = tileHash(x, y, 60 + i);
    const ry = 1 + Math.floor(seed * 13);
    const rx = ((Math.floor(seed * 7) + t) % 22) - 5;
    const rw = 4 + Math.floor(seed * 4);
    if (rx + rw <= 0 || rx >= ART) continue;
    const left = Math.max(rx, 0);
    const right = Math.min(rx + rw, ART);
    fxa(ctx, ox, oy, left, ry, right - left, 1, p.hi, 0.55);
    fxa(ctx, ox, oy, left + 1, ry - 1, Math.max(1, right - left - 2), 1, p.hi, 0.28);
  }
}

// ---------------------------------------------------------------------------
// Terrain cache
// ---------------------------------------------------------------------------
// renderCanvas runs on every animation frame, but tiles only change when the map does -
// and the art above is far too detailed (hundreds of fills per cell) to redraw 60 times a
// second. So terrain is rasterised once into an offscreen canvas and blitted from then on,
// rebuilt only when the tile grid actually changes. Water is the one animated material, so
// its cells are remembered and their moving highlights drawn per frame on top.

let terrainCanvas: HTMLCanvasElement | null = null;
/** Copy of the tile grid the cache was drawn from, for diffing. */
let terrainTiles: TileType[][] | null = null;
let waterCells: Array<{ x: number; y: number }> = [];

function drawTerrainCell(tctx: CanvasRenderingContext2D, map: GridMap, x: number, y: number) {
  tctx.clearRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  renderTile(tctx, map.tiles[y]?.[x] || 'floor_tile', x, y, map.tiles);
}

function getTerrain(map: GridMap): HTMLCanvasElement {
  const w = map.width * CELL_SIZE;
  const h = map.height * CELL_SIZE;
  const canvas = terrainCanvas ?? document.createElement('canvas');
  const needsFullRedraw =
    !terrainCanvas ||
    !terrainTiles ||
    canvas.width !== w ||
    canvas.height !== h ||
    terrainTiles.length !== map.height;

  if (needsFullRedraw) {
    canvas.width = w;
    canvas.height = h;
  }

  const tctx = canvas.getContext('2d')!;
  tctx.imageSmoothingEnabled = false;

  if (needsFullRedraw) {
    tctx.clearRect(0, 0, w, h);
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) drawTerrainCell(tctx, map, tx, ty);
    }
  } else {
    // Incremental: the map builder edits one cell at a time, and a full rasterise of a
    // 32x24 map runs into six figures of fills - enough to be felt as a hitch on every
    // click. Only the edited cells and their neighbours are redrawn, because a cell's art
    // depends on what surrounds it (wall caps, contact shadows, shoreline foam).
    const dirty = new Set<number>();
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        if (map.tiles[ty]?.[tx] === terrainTiles![ty]?.[tx]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            dirty.add(ny * map.width + nx);
          }
        }
      }
    }
    if (dirty.size === 0) return canvas;
    dirty.forEach((idx) => drawTerrainCell(tctx, map, idx % map.width, Math.floor(idx / map.width)));
  }

  terrainTiles = map.tiles.map((row) => [...row]);
  waterCells = [];
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (map.tiles[ty]?.[tx] === 'water') waterCells.push({ x: tx, y: ty });
    }
  }

  terrainCanvas = canvas;
  return canvas;
}

// ============================================================================
// Objects
// ============================================================================

function renderObject(ctx: CanvasRenderingContext2D, obj: MapObject) {
  const ox = obj.x * CELL_SIZE;
  const oy = obj.y * CELL_SIZE;
  const W = (obj.width || 1) * ART; // object width in art pixels
  const H = (obj.height || 1) * ART;

  ctx.save();

  // Contact shadow. Two bands rather than one flat block: a tight, darker core right under
  // the object and a wider soft skirt, which is what sits a sprite *on* the floor instead of
  // hovering it over a grey rectangle. Matches the light direction used everywhere else.
  fx(ctx, ox, oy, 1, H - 2, W - 1, 2, 'rgba(20, 26, 44, 0.38)');
  fx(ctx, ox, oy, 2, H, W - 1, 1, 'rgba(20, 26, 44, 0.16)');
  fx(ctx, ox, oy, W - 2, 2, 2, H - 2, 'rgba(20, 26, 44, 0.22)');

  switch (obj.type) {
    case 'desk': {
      const isClaimed = !!obj.data?.deskState?.claimedByUserId;
      const wood: Ramp = isClaimed ? PALETTE.amber : PALETTE.oak;

      // Desktop slab
      shadedBlock(ctx, ox, oy, 0, 2, W - 1, H - 4, wood);
      // Wood grain across the top
      for (let i = 2; i < W - 3; i += 5) {
        fx(ctx, ox, oy, i, 5, 3, 1, wood.dark);
        fx(ctx, ox, oy, i + 2, H - 7, 2, 1, wood.hi);
      }

      const cx = Math.floor(W / 2);

      // Desk mat / mousepad
      const matW = Math.max(8, Math.floor(W * 0.5));
      const matX = cx - Math.floor(matW / 2);
      const matY = H - 9;
      fx(ctx, ox, oy, matX, matY, matW, 5, isClaimed ? PALETTE.indigo.dark : ACCENT.ink);
      ox1(ctx, ox, oy, matX, matY, matW, 5, OUTLINE);
      fx(ctx, ox, oy, matX + 1, matY + 1, matW - 2, 1, isClaimed ? PALETTE.indigo.light : ACCENT.sky);

      // Keyboard + mouse on the mat
      const kbW = Math.max(5, matW - 5);
      fx(ctx, ox, oy, matX + 1, matY + 2, kbW, 2, PALETTE.steel.light);
      ox1(ctx, ox, oy, matX + 1, matY + 2, kbW, 2, OUTLINE);
      for (let i = matX + 2; i < matX + kbW; i += 2) {
        fx(ctx, ox, oy, i, matY + 3, 1, 1, PALETTE.steel.dark);
      }
      fx(ctx, ox, oy, matX + kbW + 2, matY + 2, 2, 2, PALETTE.steel.hi);
      ox1(ctx, ox, oy, matX + kbW + 2, matY + 2, 2, 2, OUTLINE);

      // Equipment on the back edge of the desk
      const equipment = obj.data?.deskState?.equipment || 'laptop';
      const scrY = 3;

      const drawScreen = (sx: number, sw: number, sh: number, screen: Ramp, content: () => void) => {
        shadedBlock(ctx, ox, oy, sx, scrY, sw, sh, PALETTE.steel);
        fx(ctx, ox, oy, sx + 1, scrY + 1, sw - 2, sh - 2, screen.dark);
        content();
        fx(ctx, ox, oy, sx + 1, scrY + 1, sw - 2, 1, screen.hi); // screen glare
      };

      if (equipment === 'dual_monitors') {
        drawScreen(cx - 11, 10, 7, PALETTE.water, () => {
          fx(ctx, ox, oy, cx - 9, scrY + 2, 6, 1, PALETTE.water.hi);
          fx(ctx, ox, oy, cx - 9, scrY + 4, 4, 1, ACCENT.pink);
        });
        drawScreen(cx + 1, 10, 7, PALETTE.indigo, () => {
          fx(ctx, ox, oy, cx + 3, scrY + 2, 6, 1, PALETTE.indigo.hi);
          fx(ctx, ox, oy, cx + 3, scrY + 4, 3, 1, ACCENT.lime);
        });
        fx(ctx, ox, oy, cx - 1, scrY + 7, 2, 2, PALETTE.steel.dark); // shared stand
      } else if (equipment === 'designer_tablet') {
        drawScreen(cx - 10, 20, 8, PALETTE.leaf, () => {
          fx(ctx, ox, oy, cx - 8, scrY + 2, 4, 4, ACCENT.red);
          fx(ctx, ox, oy, cx - 3, scrY + 2, 4, 4, ACCENT.yellow);
          fx(ctx, ox, oy, cx + 2, scrY + 2, 4, 4, ACCENT.teal);
        });
      } else if (equipment === 'gaming_rig') {
        // RGB spill behind the screen
        fx(ctx, ox, oy, cx - 10, scrY - 1, 20, 10, 'rgba(236, 72, 153, 0.35)');
        drawScreen(cx - 9, 18, 8, { ...PALETTE.indigo, dark: '#3f3663' }, () => {
          fx(ctx, ox, oy, cx - 7, scrY + 2, 14, 1, ACCENT.pink);
          fx(ctx, ox, oy, cx - 7, scrY + 4, 9, 1, ACCENT.teal);
          fx(ctx, ox, oy, cx - 7, scrY + 5, 5, 1, ACCENT.lime);
        });
      } else {
        // Laptop: lid + hinge + deck
        drawScreen(cx - 7, 14, 7, PALETTE.water, () => {
          fx(ctx, ox, oy, cx - 5, scrY + 2, 8, 1, PALETTE.water.hi);
          fx(ctx, ox, oy, cx - 5, scrY + 4, 5, 1, ACCENT.cream);
        });
        fx(ctx, ox, oy, cx - 8, scrY + 7, 16, 2, PALETTE.steel.base);
        ox1(ctx, ox, oy, cx - 8, scrY + 7, 16, 2, OUTLINE);
      }

      // Coffee mug (top-right) and sticky note (top-left)
      fx(ctx, ox, oy, W - 6, 3, 4, 4, ACCENT.red);
      ox1(ctx, ox, oy, W - 6, 3, 4, 4, OUTLINE);
      fx(ctx, ox, oy, W - 5, 4, 2, 1, '#6b4526'); // coffee surface
      fx(ctx, ox, oy, W - 2, 4, 1, 2, ACCENT.red); // handle

      fx(ctx, ox, oy, 2, 3, 4, 4, ACCENT.yellow);
      ox1(ctx, ox, oy, 2, 3, 4, 4, OUTLINE);
      fx(ctx, ox, oy, 3, 4, 2, 1, ACCENT.orange);
      fx(ctx, ox, oy, 3, 5, 2, 1, ACCENT.orange);

      // Nameplate / label along the bottom edge
      const centerScreenX = ox + (W * PX) / 2;
      if (obj.data?.deskState?.claimedByUserName) {
        const owner = obj.data.deskState.claimedByUserName;
        ctx.font = 'bold 9px "Pixelify Sans", cursive, sans-serif';
        const textW = ctx.measureText(`👤 ${owner}`).width;
        const plateW = Math.min(W * PX - 8, textW + 10);
        const plateX = centerScreenX - plateW / 2;
        const plateY = oy + (H - 3) * PX;
        ctx.fillStyle = OUTLINE;
        ctx.fillRect(plateX - PX, plateY - PX, plateW + PX * 2, 11 + PX);
        ctx.fillStyle = ACCENT.yellow;
        ctx.fillRect(plateX, plateY, plateW, 11);
        ctx.fillStyle = OUTLINE;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`👤 ${owner}`, centerScreenX, plateY + 6);
      } else {
        // Unclaimed: a dark plate keeps the label readable over both light and dark
        // floors, and clipping to the desk stops long names spilling onto neighbours.
        const label = obj.data?.deskState?.deskLabel || obj.name || 'Workstation';
        ctx.font = '9px "Pixelify Sans", cursive, sans-serif';
        const textW = ctx.measureText(label).width;
        const plateW = Math.min(W * PX - 6, textW + 10);
        const plateX = centerScreenX - plateW / 2;
        const plateY = oy + (H - 3) * PX;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(plateX, plateY, plateW, 11);
        ctx.save();
        ctx.beginPath();
        ctx.rect(plateX, plateY, plateW, 11);
        ctx.clip();
        ctx.fillStyle = PALETTE.marble.base;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, centerScreenX, plateY + 6);
        ctx.restore();
      }
      break;
    }

    case 'chair': {
      const p = PALETTE.steel;
      // Seen from above: backrest at the top in a darker tone, seat cushion below in a
      // lighter one. The tonal split (rather than one flat colour) is what makes the
      // two parts legible at this size.
      const back: Ramp = { ...PALETTE.indigo, base: PALETTE.indigo.dark, light: PALETTE.indigo.base };
      const seat = PALETTE.indigo;

      shadedBlock(ctx, ox, oy, 2, 0, 12, 5, back); // backrest
      fx(ctx, ox, oy, 4, 2, 8, 1, PALETTE.indigo.base); // lumbar line

      shadedBlock(ctx, ox, oy, 1, 5, 14, 8, seat); // seat cushion
      fx(ctx, ox, oy, 3, 8, 10, 1, seat.dark); // cushion seam
      fx(ctx, ox, oy, 3, 6, 10, 1, seat.hi); // cushion catch-light

      shadedBlock(ctx, ox, oy, 0, 5, 2, 6, p); // armrests
      shadedBlock(ctx, ox, oy, 14, 5, 2, 6, p);

      shadedBlock(ctx, ox, oy, 6, 13, 4, 2, p); // gas lift
      fx(ctx, ox, oy, 4, 14, 2, 1, p.dark); // castors
      fx(ctx, ox, oy, 10, 14, 2, 1, p.dark);
      break;
    }

    case 'couch': {
      const p = PALETTE.indigo;
      // Darker backrest behind lighter seat cushions - same trick as the chair, so the
      // parts separate without needing outlines everywhere.
      const back: Ramp = { ...p, base: p.dark, light: p.base };

      shadedBlock(ctx, ox, oy, 0, 1, W, 5, back); // backrest
      fx(ctx, ox, oy, 2, 3, W - 4, 1, p.base); // backrest seam

      shadedBlock(ctx, ox, oy, 0, 5, 3, H - 6, back); // armrests
      shadedBlock(ctx, ox, oy, W - 3, 5, 3, H - 6, back);

      const seatW = W - 6;
      const cushions = Math.max(2, Math.round(seatW / 8));
      const cw = Math.floor(seatW / cushions);
      for (let i = 0; i < cushions; i++) {
        const cxs = 3 + i * cw;
        const cwidth = i === cushions - 1 ? seatW - i * cw : cw;
        shadedBlock(ctx, ox, oy, cxs, 6, cwidth, H - 8, p);
        fx(ctx, ox, oy, cxs + 1, 7, cwidth - 2, 1, p.hi); // cushion piping
      }
      break;
    }

    case 'plant': {
      const pot = PALETTE.amber;
      const leaf = PALETTE.leaf;

      // Foliage drawn back-to-front: darker outer fronds first, brighter ones on top,
      // so the canopy reads as layered leaves rather than one green mass.
      const fronds: Array<[number, number, number, number, string]> = [
        [1, 3, 5, 4, leaf.dark],
        [10, 3, 5, 4, leaf.dark],
        [3, 0, 4, 5, leaf.base],
        [9, 0, 4, 5, leaf.base],
        [5, 2, 6, 6, leaf.light],
      ];
      fronds.forEach(([lx, ly, lw, lh, shade]) => {
        fx(ctx, ox, oy, lx, ly, lw, lh, shade);
        ox1(ctx, ox, oy, lx, ly, lw, lh, OUTLINE);
      });
      // Leaf veins / specular on the front frond
      fx(ctx, ox, oy, 7, 3, 2, 4, leaf.hi);
      fx(ctx, ox, oy, 6, 4, 4, 1, leaf.hi);

      // Terracotta pot: wide rim over a tapered body.
      shadedBlock(ctx, ox, oy, 3, 9, 10, 3, { ...pot, base: pot.light, light: pot.hi });
      fx(ctx, ox, oy, 4, 10, 8, 1, '#4a3020'); // soil in the rim
      shadedBlock(ctx, ox, oy, 4, 12, 8, 4, pot);
      fx(ctx, ox, oy, 5, 13, 1, 2, pot.hi); // pot highlight
      break;
    }

    case 'computer': {
      const p = PALETTE.steel;
      // A single monitor on a stand reads far better at 1 tile than a cramped
      // tower-plus-monitor pair, so this is deliberately one clear silhouette.
      shadedBlock(ctx, ox, oy, 1, 1, 14, 9, p);
      fx(ctx, ox, oy, 3, 3, 10, 5, PALETTE.water.dark); // screen

      // Screen content: a couple of "code" lines plus a cursor block.
      fx(ctx, ox, oy, 4, 4, 6, 1, PALETTE.water.hi);
      fx(ctx, ox, oy, 4, 6, 4, 1, ACCENT.lime);
      fx(ctx, ox, oy, 9, 6, 1, 1, ACCENT.yellow);
      fx(ctx, ox, oy, 3, 3, 10, 1, ACCENT.sky); // glare band

      fx(ctx, ox, oy, 13, 8, 1, 1, ACCENT.green); // power LED

      shadedBlock(ctx, ox, oy, 7, 10, 2, 2, p); // neck
      shadedBlock(ctx, ox, oy, 4, 12, 8, 2, p); // foot
      break;
    }

    case 'whiteboard': {
      // Frame + board + marker tray
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 3, PALETTE.steel);
      fx(ctx, ox, oy, 2, 2, W - 4, H - 8, ACCENT.cream);
      fx(ctx, ox, oy, 2, 2, W - 4, 1, ACCENT.cream);
      // Doodles
      fx(ctx, ox, oy, 4, 5, Math.max(4, W - 12), 1, ACCENT.red);
      fx(ctx, ox, oy, 4, 7, Math.max(3, W - 9), 1, ACCENT.green);
      fx(ctx, ox, oy, 4, 9, Math.max(3, W - 14), 1, ACCENT.blue);
      // Marker tray with three markers
      shadedBlock(ctx, ox, oy, 1, H - 4, W - 2, 2, PALETTE.steel);
      fx(ctx, ox, oy, 3, H - 4, 3, 1, ACCENT.red);
      fx(ctx, ox, oy, 7, H - 4, 3, 1, ACCENT.blue);
      fx(ctx, ox, oy, 11, H - 4, 3, 1, ACCENT.green);
      break;
    }

    case 'sticky_notes': {
      // Cork board with pinned notes at slight offsets
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 1, { dark: '#8a6440', base: '#ab8055', light: '#c39a6d', hi: ACCENT.orange });
      const notes: Array<[number, number, string]> = [
        [2, 2, ACCENT.yellow],
        [8, 3, ACCENT.red],
        [3, 8, ACCENT.green],
        [9, 9, ACCENT.sky],
      ];
      notes.forEach(([nx, ny, color]) => {
        if (nx + 5 > W || ny + 5 > H) return;
        fx(ctx, ox, oy, nx, ny, 5, 5, color);
        ox1(ctx, ox, oy, nx, ny, 5, 5, OUTLINE);
        fx(ctx, ox, oy, nx + 1, ny + 2, 3, 1, 'rgba(15,23,42,0.35)');
        fx(ctx, ox, oy, nx + 1, ny + 3, 2, 1, 'rgba(15,23,42,0.35)');
        fx(ctx, ox, oy, nx + 2, ny, 1, 1, ACCENT.red); // pin
      });
      break;
    }

    case 'game_table': {
      shadedBlock(ctx, ox, oy, 0, 1, W, H - 2, PALETTE.darkwood);
      // Checkerboard playfield
      const boardX = 2;
      const boardY = 3;
      const cells = 6;
      const cs = Math.max(1, Math.floor((Math.min(W, H) - 6) / cells));
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          fx(ctx, ox, oy, boardX + i * cs, boardY + j * cs, cs, cs, (i + j) % 2 ? '#e6ddc8' : '#6e6390');
        }
      }
      ox1(ctx, ox, oy, boardX, boardY, cells * cs, cells * cs, OUTLINE);
      // A couple of pieces
      fx(ctx, ox, oy, boardX + cs, boardY + cs, cs, cs, ACCENT.red);
      fx(ctx, ox, oy, boardX + cs * 4, boardY + cs * 3, cs, cs, ACCENT.yellow);
      break;
    }

    case 'jukebox': {
      const body: Ramp = { dark: '#8e4256', base: '#b85f76', light: ACCENT.pink, hi: '#e9a9c0' };
      // Arched top
      fx(ctx, ox, oy, 2, 1, W - 4, 2, body.light);
      fx(ctx, ox, oy, 1, 3, W - 2, H - 5, body.base);
      ox1(ctx, ox, oy, 1, 3, W - 2, H - 5, OUTLINE);
      ox1(ctx, ox, oy, 2, 1, W - 4, 3, OUTLINE);
      // Glowing arch light
      fx(ctx, ox, oy, 3, 2, W - 6, 1, ACCENT.yellow);
      // Speaker grille
      fx(ctx, ox, oy, 3, 5, W - 6, 5, body.dark);
      for (let i = 4; i < W - 4; i += 2) {
        fx(ctx, ox, oy, i, 5, 1, 5, '#4a2733');
      }
      // Control buttons
      fx(ctx, ox, oy, 4, 11, 2, 2, ACCENT.teal);
      fx(ctx, ox, oy, 7, 11, 2, 2, ACCENT.yellow);
      fx(ctx, ox, oy, 10, 11, 2, 2, ACCENT.lime);
      break;
    }

    case 'tv': {
      // Wall-mounted flat screen
      shadedBlock(ctx, ox, oy, 0, 1, W, H - 4, PALETTE.steel);
      fx(ctx, ox, oy, 2, 3, W - 4, H - 8, PALETTE.water.dark);
      // Screen content + scanlines
      fx(ctx, ox, oy, 3, 4, W - 6, 2, ACCENT.sky);
      fx(ctx, ox, oy, 3, 7, Math.max(2, W - 10), 2, ACCENT.sky);
      for (let j = 4; j < H - 5; j += 2) {
        fx(ctx, ox, oy, 2, j, W - 4, 1, 'rgba(12, 74, 110, 0.35)');
      }
      fx(ctx, ox, oy, 2, 3, W - 4, 1, ACCENT.sky); // glare
      // Stand
      shadedBlock(ctx, ox, oy, Math.floor(W / 2) - 2, H - 3, 4, 1, PALETTE.steel);
      shadedBlock(ctx, ox, oy, Math.floor(W / 2) - 4, H - 2, 8, 1, PALETTE.steel);
      break;
    }

    case 'coffee_machine': {
      const body: Ramp = { dark: '#4a3122', base: '#6d4a33', light: '#8d6446', hi: '#b28a64' };
      const steel = PALETTE.steel;

      // Tall body with a chrome upper deck, so the machine silhouette is obvious.
      shadedBlock(ctx, ox, oy, 1, 0, 14, 12, body);
      shadedBlock(ctx, ox, oy, 2, 1, 12, 3, steel); // chrome top / bean hopper
      fx(ctx, ox, oy, 3, 2, 4, 1, ACCENT.green); // ready lamp
      fx(ctx, ox, oy, 11, 2, 2, 1, ACCENT.red); // power lamp

      // Group head with the portafilter below it.
      shadedBlock(ctx, ox, oy, 5, 5, 6, 2, steel);
      fx(ctx, ox, oy, 7, 7, 2, 1, '#4a3020'); // espresso stream

      // Cup sitting on the drip tray.
      shadedBlock(ctx, ox, oy, 6, 8, 4, 3, PALETTE.marble);
      fx(ctx, ox, oy, 7, 9, 2, 1, '#6b4526'); // coffee surface
      fx(ctx, ox, oy, 10, 9, 1, 1, PALETTE.marble.dark); // handle

      shadedBlock(ctx, ox, oy, 3, 12, 10, 2, steel); // drip tray
      for (let i = 4; i < 12; i += 2) fx(ctx, ox, oy, i, 12, 1, 1, steel.dark); // tray grate
      break;
    }

    case 'bookshelf': {
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 1, PALETTE.darkwood);
      // Two shelves of varied book spines
      const shelfTops = [2, 9];
      shelfTops.forEach((sy, si) => {
        fx(ctx, ox, oy, 1, sy + 5, W - 2, 1, PALETTE.darkwood.dark); // shelf board
        let bx = 2;
        let i = 0;
        while (bx < W - 3) {
          const bw = 1 + ((i + si) % 3);
          const bh = 4 - ((i + si) % 2);
          const colors = [ACCENT.red, ACCENT.blue, ACCENT.green, ACCENT.yellow, ACCENT.violet, ACCENT.teal];
          const color = colors[(i * 2 + si * 3) % colors.length];
          if (bx + bw > W - 2) break;
          const by2 = sy + 5 - bh;
          fx(ctx, ox, oy, bx, by2, bw, bh, color);
          // Spines are 1-3 art pixels wide, so a full outline around each one consumed the
          // entire book and the shelf came out as a row of dark slots. A shadow down the
          // right edge and a lit top separates them while leaving the colour visible.
          fx(ctx, ox, oy, bx + bw - 1, by2, 1, bh, mixHex(color, OUTLINE, 0.45));
          fx(ctx, ox, oy, bx, by2, bw, 1, mixHex(color, '#ffffff', 0.3));
          bx += bw + 1;
          i++;
        }
      });
      break;
    }

    case 'door': {
      // Frame
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 1, PALETTE.steel);
      // Door leaf with two recessed panels
      shadedBlock(ctx, ox, oy, 2, 1, W - 4, H - 3, PALETTE.darkwood);
      const panelW = W - 8;
      fx(ctx, ox, oy, 4, 3, panelW, 4, PALETTE.darkwood.dark);
      ox1(ctx, ox, oy, 4, 3, panelW, 4, PALETTE.darkwood.hi);
      fx(ctx, ox, oy, 4, 9, panelW, 4, PALETTE.darkwood.dark);
      ox1(ctx, ox, oy, 4, 9, panelW, 4, PALETTE.darkwood.hi);
      // Handle
      fx(ctx, ox, oy, W - 5, 7, 2, 2, PALETTE.amber.light);
      ox1(ctx, ox, oy, W - 5, 7, 2, 2, OUTLINE);
      break;
    }

    default: {
      shadedBlock(ctx, ox, oy, 1, 1, W - 2, H - 2, PALETTE.steel);
      break;
    }
  }

  ctx.restore();
}

// Interpolated user positions map for smooth animated movement
const displayPosMap = new Map<string, { x: number; y: number; isMoving: boolean }>();
let animFrameId: number | null = null;

// ============================================================================
// Character avatars
// ============================================================================
// The sprite itself lives in lib/avatarSprite.ts so the world canvas and the Avatar Studio
// preview draw the exact same character. What stays here is only the world-specific chrome
// around it: proximity rings, the walk cycle driven by interpolated movement, and the name
// tag - none of which belong in a preview.

function renderUser(
  ctx: CanvasRenderingContext2D,
  user: User,
  isSelf: boolean,
  displayPos: { x: number; y: number; isMoving: boolean },
  isGhost = false
) {
  const px = displayPos.x * CELL_SIZE + CELL_SIZE / 2;
  let py = displayPos.y * CELL_SIZE + CELL_SIZE / 2;

  // Rhythmic walking bounce
  if (displayPos.isMoving) {
    py -= Math.abs(Math.sin(Date.now() / 90)) * 2;
  }

  ctx.save();

  // Ghost Mode: your own avatar turns translucent while phasing through others
  if (isSelf && isGhost) {
    ctx.globalAlpha = 0.45;
  }

  // Proximity Voice Halo Ring (If speaking)
  if (user.isSpeaking) {
    ctx.strokeStyle = ACCENT.green;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(px, py - 8, 28, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (isSelf) {
    // Proximity 4-tile spatial voice radius visual circle
    ctx.strokeStyle = '#7d8ae0';
    ctx.fillStyle = 'rgba(125, 138, 224, 0.07)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.arc(px, py, 4 * CELL_SIZE, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // While an avatar lerps between tiles its centre lands on a fractional pixel; snapping the
  // sprite origin to whole screen pixels is what stops a pixel character shimmering as it
  // walks.
  const oxp = Math.round(px - (AV_W / 2) * PX);
  const oyp = Math.round(py + 13 - AV_H * PX);

  drawAvatarSprite(ctx, oxp, oyp, PX, user.avatar, {
    direction: user.direction,
    walkPhase: displayPos.isMoving ? Math.floor(Date.now() / 120) % 4 : -1,
    presence: user.presenceStatus,
    showEmoji: true,
  });

  // --- Name tag ---------------------------------------------------------------
  const nameText = isSelf ? `${user.name} (YOU)` : user.name;
  ctx.font = 'bold 12px "Pixelify Sans", cursive, sans-serif';
  const textWidth = ctx.measureText(nameText).width;

  const tagW = textWidth + 14;
  const tagH = 20;
  const tagX = Math.round(px - tagW / 2);
  const tagY = oyp - tagH - 6;

  ctx.fillStyle = 'rgba(20, 26, 44, 0.45)';
  ctx.fillRect(tagX + 3, tagY + 3, tagW, tagH);
  ctx.fillStyle = isSelf ? '#f6e7bd' : ACCENT.cream;
  ctx.fillRect(tagX, tagY, tagW, tagH);
  ctx.fillStyle = AVATAR_INK;
  ctx.fillRect(tagX, tagY, tagW, 2);
  ctx.fillRect(tagX, tagY + tagH - 2, tagW, 2);
  ctx.fillRect(tagX, tagY, 2, tagH);
  ctx.fillRect(tagX + tagW - 2, tagY, 2, tagH);

  ctx.fillStyle = AVATAR_INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(nameText, tagX + tagW / 2, tagY + tagH / 2 + 1);

  ctx.restore();
}

// Main Render Loop
function renderCanvas() {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const map = props.currentMap;
  // Assigning width/height resets the whole 2D context - including imageSmoothingEnabled -
  // so only resize when the map actually changed, and set the smoothing flag afterwards.
  // Smoothing has to stay off or the terrain blit below would come out blurred.
  if (canvas.width !== map.width * CELL_SIZE || canvas.height !== map.height * CELL_SIZE) {
    canvas.width = map.width * CELL_SIZE;
    canvas.height = map.height * CELL_SIZE;
  }
  ctx.imageSmoothingEnabled = false;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw Tiles (cached; only the animated water highlights are per-frame work)
  ctx.drawImage(getTerrain(map), 0, 0);
  waterCells.forEach(({ x, y }) => renderWaterAnimation(ctx, x, y));

  // 2. Draw Private Zones Overlays (Explicit & Desk Automatic Private Zones)
  const allZones: Array<{ id: string; name: string; color?: string; x: number; y: number; width: number; height: number; isDeskZone?: boolean }> = [
    ...(map.privateZones || []).map((z) => ({ ...z, isDeskZone: false })),
  ];

  (map.objects || []).forEach((obj) => {
    if (obj.type === 'desk') {
      const deskW = obj.width || 2;
      const deskH = obj.height || 1;
      const label = obj.data?.deskState?.deskLabel || obj.name || 'Desk';
      allZones.push({
        id: `desk_zone_${obj.id}`,
        name: label,
        color: 'rgba(99, 102, 241, 0.12)',
        x: obj.x,
        y: obj.y + deskH,
        width: deskW,
        height: 1,
        isDeskZone: true,
      });
    }
  });

  allZones.forEach((zone) => {
    const zx = zone.x * CELL_SIZE;
    const zy = zone.y * CELL_SIZE;
    const zw = zone.width * CELL_SIZE;
    const zh = zone.height * CELL_SIZE;

    ctx.fillStyle = zone.color || 'rgba(99, 102, 241, 0.18)';
    ctx.fillRect(zx, zy, zw, zh);

    ctx.strokeStyle = zone.isDeskZone ? '#6366f1' : '#312e81';
    ctx.lineWidth = zone.isDeskZone ? 2 : 3;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(zx + 2, zy + 2, zw - 4, zh - 4);
    ctx.setLineDash([]);

    if (zone.isDeskZone) {
      // Subtle desk zone tag
      ctx.font = 'bold 9px "Pixelify Sans", cursive, sans-serif';
      const labelText = `🔒 ${zone.name}`;
      const textW = ctx.measureText(labelText).width + 8;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(zx + zw / 2 - textW / 2, zy + zh - 13, textW, 11);
      ctx.fillStyle = '#67e8f9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, zx + zw / 2, zy + zh - 7);
    } else {
      // Zone Title Tag Box
      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(zx + 8, zy + 8, zone.name.length * 10 + 28, 22);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.strokeRect(zx + 8, zy + 8, zone.name.length * 10 + 28, 22);

      ctx.font = 'bold 11px "Silkscreen", cursive';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(`🔒 ${zone.name}`, zx + 14, zy + 22);
    }
  });

  // 3. Draw Objects
  map.objects.forEach((obj) => {
    renderObject(ctx, obj);
  });

  // 4. Draw Users with lerp position interpolation and walking animation
  props.users.forEach((user) => {
    let currentPos = displayPosMap.get(user.socketId);
    const targetX = user.position?.x ?? 0;
    const targetY = user.position?.y ?? 0;

    if (!currentPos) {
      currentPos = { x: targetX, y: targetY, isMoving: false };
      displayPosMap.set(user.socketId, currentPos);
    } else {
      const dx = targetX - currentPos.x;
      const dy = targetY - currentPos.y;
      const dist = Math.hypot(dx, dy);

      // If user teleported far away (e.g. > 4 tiles), snap immediately
      if (dist > 4) {
        currentPos.x = targetX;
        currentPos.y = targetY;
        currentPos.isMoving = false;
      } else if (dist > 0.01) {
        currentPos.x += dx * 0.25;
        currentPos.y += dy * 0.25;
        currentPos.isMoving = true;
      } else {
        currentPos.x = targetX;
        currentPos.y = targetY;
        currentPos.isMoving = false;
      }
    }

    const isSelfUser = user.socketId === props.currentUser.socketId;
    renderUser(ctx, user, isSelfUser, currentPos, isSelfUser && isGhostMode.value);
  });

  followCameraOnMobile();
}

function startAnimLoop() {
  renderCanvas();
  animFrameId = requestAnimationFrame(startAnimLoop);
}

let lastKeyMoveTime = 0;
const KEY_MOVE_COOLDOWN_MS = 140;

// Shared movement step, used by both keyboard input and the on-screen mobile D-pad
function movePlayer(dx: number, dy: number, dir: 'up' | 'down' | 'left' | 'right') {
  const now = Date.now();
  if (now - lastKeyMoveTime < KEY_MOVE_COOLDOWN_MS) {
    return;
  }
  lastKeyMoveTime = now;

  const targetX = props.currentUser.position.x + dx;
  const targetY = props.currentUser.position.y + dy;

  emit('move', { x: targetX, y: targetY, direction: dir, ghost: isGhostMode.value });
}

// Keydown Movement Listener
function handleKeyDown(e: KeyboardEvent) {
  if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
    return;
  }

  if (e.key === 'g' || e.key === 'G') {
    isGhostMode.value = true;
    return;
  }

  let dx = 0;
  let dy = 0;
  let dir: 'up' | 'down' | 'left' | 'right' = 'down';

  switch (e.key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      dy = -1;
      dir = 'up';
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      dy = 1;
      dir = 'down';
      break;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      dx = -1;
      dir = 'left';
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      dx = 1;
      dir = 'right';
      break;
    default:
      return;
  }

  e.preventDefault();
  movePlayer(dx, dy, dir);
}

// Keyup: releasing "g" ends Ghost Mode. Also handles the tab losing focus while held
// (window blur) so ghost mode never gets "stuck" on.
function handleKeyUp(e: KeyboardEvent) {
  if (e.key === 'g' || e.key === 'G') {
    isGhostMode.value = false;
  }
}

function endGhostMode() {
  isGhostMode.value = false;
}

// On-screen mobile D-pad: fires an immediate move, then repeats while held
let dpadInterval: number | null = null;
function startDpadMove(dx: number, dy: number, dir: 'up' | 'down' | 'left' | 'right') {
  stopDpadMove();
  movePlayer(dx, dy, dir);
  dpadInterval = window.setInterval(() => movePlayer(dx, dy, dir), KEY_MOVE_COOLDOWN_MS);
}
function stopDpadMove() {
  if (dpadInterval !== null) {
    clearInterval(dpadInterval);
    dpadInterval = null;
  }
}

// Canvas Click Event Handler
function handleCanvasClick(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;

  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const tileX = Math.floor(clickX / CELL_SIZE);
  const tileY = Math.floor(clickY / CELL_SIZE);

  if (props.builderMode) {
    if (props.builderAction === 'erase') {
      const existingObj = props.currentMap.objects.find(
        (o) => tileX >= o.x && tileX < o.x + o.width && tileY >= o.y && tileY < o.y + o.height
      );
      if (existingObj) {
        emit('removeObject', existingObj.id);
      }
    } else {
      if (props.selectedObject) {
        const isDesk = props.selectedObject.type === 'desk';
        const newObj: MapObject = {
          ...props.selectedObject,
          id: `obj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          x: tileX,
          y: tileY,
          data: isDesk
            ? {
                deskState: {
                  deskLabel: 'Workstation Desk',
                  equipment: 'laptop',
                  stickyNotes: [],
                  ...(props.selectedObject.data?.deskState || {}),
                },
                ...(props.selectedObject.data || {}),
              }
            : props.selectedObject.data,
        };
        emit('placeObject', newObj);
      } else if (props.selectedTile) {
        emit('changeTile', { x: tileX, y: tileY, tileType: props.selectedTile });
      }
    }
  } else {
    const clickedObj = props.currentMap.objects.find(
      (o) => tileX >= o.x && tileX < o.x + o.width && tileY >= o.y && tileY < o.y + o.height
    );

    if (clickedObj) {
      emit('interactObject', clickedObj);
    } else {
      emit('navigateTile', { x: tileX, y: tileY });
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', endGhostMode);
  updateIsMobile();
  window.addEventListener('resize', updateIsMobile);
  startAnimLoop();
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('blur', endGhostMode);
  window.removeEventListener('resize', updateIsMobile);
  stopDpadMove();
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
  }
});

watch([() => props.currentUser, () => props.users, () => props.currentMap, () => props.builderMode], () => {
  renderCanvas();
}, { deep: true });
</script>

<template>
  <div
    ref="scrollContainerRef"
    :class="[
      'w-full h-full overflow-auto custom-scrollbar',
      isMobile ? 'block' : 'flex items-center justify-center p-4',
    ]"
  >
    <div class="inline-block relative border-4 border-slate-900 shadow-[8px_8px_0px_0px_#020617] bg-slate-900 overflow-hidden rounded-2xl pixel-rendering">
      <canvas
        ref="canvasRef"
        @click="handleCanvasClick"
        class="cursor-pointer block touch-none pixel-rendering"
      />
    </div>
  </div>

  <!-- Mobile D-Pad: move widget for touch devices, camera follows the player automatically -->
  <div class="md:hidden fixed bottom-24 right-4 z-40 grid grid-cols-3 grid-rows-3 gap-1 select-none">
    <button
      type="button"
      class="col-start-2 row-start-1 w-11 h-11 flex items-center justify-center bg-white border-2 border-slate-900 rounded-xl shadow-[3px_3px_0px_0px_#0f172a] active:translate-x-px active:translate-y-px active:shadow-none touch-none"
      @pointerdown.prevent="startDpadMove(0, -1, 'up')"
      @pointerup="stopDpadMove"
      @pointerleave="stopDpadMove"
      @pointercancel="stopDpadMove"
      aria-label="Move up"
    >
      <ChevronUp class="w-6 h-6 text-slate-900" />
    </button>
    <button
      type="button"
      class="col-start-1 row-start-2 w-11 h-11 flex items-center justify-center bg-white border-2 border-slate-900 rounded-xl shadow-[3px_3px_0px_0px_#0f172a] active:translate-x-px active:translate-y-px active:shadow-none touch-none"
      @pointerdown.prevent="startDpadMove(-1, 0, 'left')"
      @pointerup="stopDpadMove"
      @pointerleave="stopDpadMove"
      @pointercancel="stopDpadMove"
      aria-label="Move left"
    >
      <ChevronLeft class="w-6 h-6 text-slate-900" />
    </button>
    <button
      type="button"
      class="col-start-3 row-start-2 w-11 h-11 flex items-center justify-center bg-white border-2 border-slate-900 rounded-xl shadow-[3px_3px_0px_0px_#0f172a] active:translate-x-px active:translate-y-px active:shadow-none touch-none"
      @pointerdown.prevent="startDpadMove(1, 0, 'right')"
      @pointerup="stopDpadMove"
      @pointerleave="stopDpadMove"
      @pointercancel="stopDpadMove"
      aria-label="Move right"
    >
      <ChevronRight class="w-6 h-6 text-slate-900" />
    </button>
    <button
      type="button"
      class="col-start-2 row-start-3 w-11 h-11 flex items-center justify-center bg-white border-2 border-slate-900 rounded-xl shadow-[3px_3px_0px_0px_#0f172a] active:translate-x-px active:translate-y-px active:shadow-none touch-none"
      @pointerdown.prevent="startDpadMove(0, 1, 'down')"
      @pointerup="stopDpadMove"
      @pointerleave="stopDpadMove"
      @pointercancel="stopDpadMove"
      aria-label="Move down"
    >
      <ChevronDown class="w-6 h-6 text-slate-900" />
    </button>
  </div>
</template>
