<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
import type { User, GridMap, MapObject, TileType } from "../types";
import type { KartModel } from "../lib/kartModels";
import { ACCENT, mixHex, type Ramp } from "../lib/pixelArt";
import {
  AV_BODY_CENTER_Y,
  AV_GROUND_Y,
  AV_HEAD_TOP_Y,
  AV_INK as AVATAR_INK,
  AV_W,
  drawAvatarHead,
  drawAvatarSprite,
} from "../lib/avatarSprite";
import { directionFromHeading, lerpAngle, normalizeAngle } from "../lib/kart";
import { drawKart, drawKartBoost, kartBodyColor } from "../lib/kartSprite";
import {
  ZOOM_DEFAULT,
  ZOOM_STORAGE_KEY,
  centreScroll,
  clampZoom,
  halfViewInset,
  mapPxFromClient,
  parseStoredZoom,
  tileFromClient,
  zoomFactorFromWheel,
} from "../lib/camera";

const props = defineProps<{
  currentUser: User;
  users: User[];
  currentMap: GridMap;
  builderMode: boolean;
  builderAction: "place" | "erase" | "move";
  selectedTile: TileType;
  selectedObject: MapObject | null;
  /** Drag on the map to describe a private zone rectangle, instead of typing coordinates. */
  zoneDrawMode?: boolean;
  /**
   * Our own kart while driving, sourced from the per-frame simulation: the exact tile position
   * (currentUser.position only updates at the send cadence), the heading, and whether we skid.
   */
  localKart?: { x: number; y: number; heading: number; sliding: boolean; boost: boolean } | null;
}>();

const emit = defineEmits<{
  (e: "move", payload: { x: number; y: number; direction: "up" | "down" | "left" | "right"; ghost?: boolean }): void;
  (e: "navigateTile", payload: { x: number; y: number }): void;
  (e: "interactObject", object: MapObject): void;
  (e: "placeObject", newObj: MapObject): void;
  (e: "removeObject", objectId: string): void;
  (e: "moveObject", payload: { objectId: string; x: number; y: number }): void;
  (e: "changeTile", payload: { x: number; y: number; tileType: TileType }): void;
  (e: "zoneDrawn", payload: { x: number; y: number; width: number; height: number }): void;
  (e: "userContextMenu", payload: { socketId: string; clientX: number; clientY: number }): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const scrollContainerRef = ref<HTMLDivElement | null>(null);
/** Wraps the map; driving pads it so the kart can be centred at the edges (see setCameraInset). */
const contentRef = ref<HTMLDivElement | null>(null);
const CELL_SIZE = 48; // Each spatial tile is 48x48px

// Map zoom (desktop mouse wheel). The canvas's backing store is sized to the on-screen device
// pixels (base px * zoom * devicePixelRatio, see renderCanvas), so its text stays crisp, while its
// CSS box scales with zoom. Pointer conversions must go through the laid-out rect (see clientToTile),
// never the backing store's size.
function loadStoredZoom(): number {
  try {
    return parseStoredZoom(localStorage.getItem(ZOOM_STORAGE_KEY));
  } catch (_) {
    return ZOOM_DEFAULT;
  }
}
const zoom = ref(loadStoredZoom());
function storeZoom(value: number) {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(value));
  } catch (_) {}
}

/** Current padding added to the scroll content while driving (CSS px, per side). */
let insetX = 0;
let insetY = 0;

// Object Drag & Drop State in Builder Mode
const isDraggingObject = ref(false);
const draggedObject = ref<MapObject | null>(null);
const dragOffsetGrid = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const currentDragTile = ref<{ x: number; y: number } | null>(null);
const hoveredObject = ref<MapObject | null>(null);
const isMouseDown = ref(false);
const mouseDownPos = ref<{ x: number; y: number } | null>(null);
const hasDragged = ref(false);

// Private-zone rectangle being dragged out on the map (builder mode only).
const zoneDragStart = ref<{ x: number; y: number } | null>(null);
const zoneDragEnd = ref<{ x: number; y: number } | null>(null);

/** The drag normalised into a top-left origin plus a size, clamped to the map. */
const pendingZoneRect = computed(() => {
  const a = zoneDragStart.value;
  const b = zoneDragEnd.value;
  if (!a || !b || !props.currentMap) return null;
  const x = Math.max(0, Math.min(a.x, b.x));
  const y = Math.max(0, Math.min(a.y, b.y));
  const right = Math.min(props.currentMap.width - 1, Math.max(a.x, b.x));
  const bottom = Math.min(props.currentMap.height - 1, Math.max(a.y, b.y));
  return { x, y, width: right - x + 1, height: bottom - y + 1 };
});

const canvasCursor = computed(() => {
  if (props.builderMode) {
    if (isDraggingObject.value) return "grabbing";
    if (hoveredObject.value) return "grab";
    if (props.builderAction === "erase") return "crosshair";
    if (props.builderAction === "move") return "grab";
    return "pointer";
  }
  return "pointer";
});

// Ghost Mode: holding "g" lets you walk through other users. The server is still the
// authority on collision (see server.ts user:move), this just flags the request.
const isGhostMode = ref(false);

// Camera-follow: the map is usually larger than the viewport, so followCamera auto-scrolls the
// container to keep the player's avatar centered. isMobile only turns off the wheel zoom.
const isMobile = ref(false);
function updateIsMobile() {
  isMobile.value = window.matchMedia('(max-width: 768px)').matches;
}

/**
 * Where the canvas's top-left corner sits in the container's scroll space. This is not 0: the
 * container's padding, the centring margin and any driving inset all move it. Scroll targets must
 * be computed from this, not from 0.
 */
function canvasOriginInScroll(container: HTMLElement, canvas: HTMLElement) {
  const c = container.getBoundingClientRect();
  const r = canvas.getBoundingClientRect();
  return {
    left: r.left - c.left - container.clientLeft + container.scrollLeft,
    top: r.top - c.top - container.clientTop + container.scrollTop,
  };
}

/**
 * While driving, the scrollable content is padded by half the view on each side, so the kart can
 * be centred even next to a map edge (scrolling clamps at the content edges). Toggling the padding
 * moves the canvas on screen, so the scroll is shifted by the same amount to keep the view still.
 */
function setCameraInset(x: number, y: number) {
  const container = scrollContainerRef.value;
  const content = contentRef.value;
  const canvas = canvasRef.value;
  if (!container || !content || !canvas) return;
  if (x === insetX && y === insetY) return;

  const before = canvasOriginInScroll(container, canvas);
  content.style.padding = `${y}px ${x}px`;
  insetX = x;
  insetY = y;
  const after = canvasOriginInScroll(container, canvas);
  container.scrollLeft += after.left - before.left;
  container.scrollTop += after.top - before.top;
}

function clampScroll(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function followCamera() {
  const container = scrollContainerRef.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return;

  // Inset first: it moves the canvas origin, and the origin is measured below.
  const driving = Boolean(props.currentUser.kart);
  if (driving) setCameraInset(halfViewInset(container.clientWidth), halfViewInset(container.clientHeight));
  else setCameraInset(0, 0);

  const displayPos = displayPosMap.get(props.currentUser.socketId);
  const tileX = displayPos?.x ?? props.currentUser.position?.x ?? 0;
  const tileY = displayPos?.y ?? props.currentUser.position?.y ?? 0;
  // Tile centre in base (unzoomed) px, relative to the canvas origin.
  const targetX = (tileX + 0.5) * CELL_SIZE;
  const targetY = (tileY + 0.5) * CELL_SIZE;

  const zoomNow = zoom.value;
  const origin = canvasOriginInScroll(container, canvas);
  const viewW = container.clientWidth;
  const viewH = container.clientHeight;
  const maxLeft = Math.max(0, container.scrollWidth - viewW);
  const maxTop = Math.max(0, container.scrollHeight - viewH);

  // The camera always keeps the player's avatar centred: desktop walking, driving and mobile alike,
  // on both axes, every frame. It clamps at the map edges, except while driving, where the inset
  // lets the kart sit in the true centre even next to an edge.
  const left = clampScroll(centreScroll(targetX, viewW, origin.left, zoomNow), maxLeft);
  const top = clampScroll(centreScroll(targetY, viewH, origin.top, zoomNow), maxTop);
  if (Math.round(left) !== Math.round(container.scrollLeft) || Math.round(top) !== Math.round(container.scrollTop)) {
    container.scrollTo({ left, top, behavior: 'auto' });
  }
}

/** Set the map's zoom and resize the canvas's CSS box right away, so the caller can read the new layout. */
function setZoom(next: number) {
  zoom.value = clampZoom(next);
  storeZoom(zoom.value);
  applyCanvasSize();
}

/** CSS size of the canvas = base px * zoom. Only writes when the value changes. */
function applyCanvasSize() {
  const canvas = canvasRef.value;
  const map = props.currentMap;
  if (!canvas || !map) return;
  const w = `${map.width * CELL_SIZE * zoom.value}px`;
  const h = `${map.height * CELL_SIZE * zoom.value}px`;
  if (canvas.style.width !== w) canvas.style.width = w;
  if (canvas.style.height !== h) canvas.style.height = h;
}

/**
 * Mouse wheel zooms the map on desktop. The camera always centres on the player's avatar, so the
 * zoom is followed by a re-centre (followCamera) rather than anchored on the cursor, which the
 * next frame would override anyway.
 */
function handleWheel(e: WheelEvent) {
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if (isMobile.value) return;
  e.preventDefault();

  const container = scrollContainerRef.value;
  const canvas = canvasRef.value;
  if (!container || !canvas || !props.currentMap) return;

  const oldZoom = zoom.value;
  const newZoom = clampZoom(oldZoom * zoomFactorFromWheel(e.deltaY, e.deltaMode, container.clientHeight));
  if (newZoom === oldZoom) return;

  // Synchronous: the new CSS size and the new scroll are applied before the next paint, so the
  // zoom does not flash the old scroll position.
  setZoom(newZoom);
  followCamera();
}

/**
 * The tile under a pointer event. Maps through the canvas's laid-out rect, which already includes
 * zoom, so it is right at any zoom level. Returns (-1, -1) if the canvas is not laid out yet.
 */
function clientToTile(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const canvas = canvasRef.value;
  const map = props.currentMap;
  if (!canvas || !map) return { x: -1, y: -1 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: tileFromClient(e.clientX, rect.left, rect.width, map.width),
    y: tileFromClient(e.clientY, rect.top, rect.height, map.height),
  };
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
  tones: string[];
}

const TILE: Record<string, TileRamp> = {
  oak: {
    shadow: '#5c452f',
    dark: '#87603e',
    base: '#ad8058',
    light: '#c69a72',
    hi: '#e2c096',
    tones: ['#a2754e', '#ab7e56', '#b3865d', '#a87a52', '#b88c63'],
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
    shadow: '#959ea9',
    dark: '#aeb6bf',
    base: '#c6cdd3',
    light: '#d6dce1',
    hi: '#eef1f3',
    tones: ['#c0c7ce', '#c6cdd3', '#cbd1d6', '#c3c9cf'],
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
  // Race track road. Near-black, so the red and white kerbs and the white markings carry the eye.
  asphalt: {
    shadow: '#1b1e24',
    dark: '#22262d',
    base: '#2b2f36',
    light: '#353a43',
    hi: '#41474f',
    tones: ['#292d34', '#2b2f36', '#2d3139'],
  },
};

/**
 * Kerb colours: a red and white band along the edge of the road. Each has a darker shade for
 * the row nearest the road, so the kerb reads as a raised lip rather than a flat stripe.
 */
const KERB_RED = '#c94a3d';
const KERB_RED_SHADE = '#8c2f2c';
const KERB_WHITE = '#ece7dc';
const KERB_WHITE_SHADE = '#b8b2a6';

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
/** Neutral metal for the threshold strip between two indoor floor materials. */
const EDGE_TRIM = '#9aa1ab';
/** Exposed earth at the lip of a lawn that runs up against a slab. */
const SOIL = '#4e4129';

function isWallTile(t?: TileType) {
  return t === 'wall_brick' || t === 'wall_wood';
}

const INDOOR_FLOORS: TileType[] = ['floor_wood', 'floor_carpet', 'floor_tile', 'floor_concrete'];

function isIndoorFloor(t?: TileType) {
  return t !== undefined && INDOOR_FLOORS.includes(t);
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

/**
 * Draw a hand-authored sprite: one string per art row, one char per art pixel; '.' is clear.
 * Horizontal runs of the same char become one fill. A char missing from `colors` throws, so a
 * typo in a mask fails loudly in dev instead of silently leaving a hole. `dx`/`dy` shift the
 * whole mask in art pixels, for objects larger than one tile.
 */
function drawMask(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  rows: string[],
  colors: Record<string, string>,
  dx = 0,
  dy = 0
) {
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      if (ch !== '.') {
        const color = colors[ch];
        if (color === undefined) throw new Error(`drawMask: no colour for '${ch}' on row ${y}`);
        fx(ctx, ox, oy, x + dx, y + dy, run, 1, color);
      }
      x += run;
    }
  });
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

/**
 * Where two different floor materials meet (indoor against indoor, or indoor against lawn) the
 * boundary is otherwise a hard cut, which reads as unfinished. Each side of such an edge gets a
 * thin treatment, painted from the cell that owns it:
 *  - indoor/indoor: a metal threshold on the top/left cell and a soft shadow on each side of it,
 *    so the seam reads as a fitted strip rather than two colours meeting;
 *  - indoor/lawn: the slab gets a short dark edge, as if it stands a little proud of the ground;
 *    the lawn gets a soil lip and a broken dither, so the grass looks tucked under the slab.
 * Walls are deliberately excluded (they are not indoor or grass here), so floorContactShadow
 * keeps sole ownership of wall edges. Asphalt and water keep their own kerbs and banks.
 * Terrain is cached per cell and redrawn with its neighbours, so reading neighbours is safe.
 */
function floorTransitions(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  x: number,
  y: number,
  tiles: TileType[][]
) {
  const self = tiles[y]?.[x];
  const selfIndoor = isIndoorFloor(self);
  if (!selfIndoor && self !== 'floor_grass') return;

  // Out-of-bounds neighbours are undefined and fall through to null.
  const kindAt = (dx: number, dy: number): 'indoor' | 'grass' | null => {
    const t = tiles[y + dy]?.[x + dx];
    if (t === undefined) return null;
    if (!selfIndoor) return isIndoorFloor(t) ? 'indoor' : null;
    if (t === 'floor_grass') return 'grass';
    return isIndoorFloor(t) && t !== self ? 'indoor' : null;
  };
  const top = kindAt(0, -1);
  const right = kindAt(1, 0);
  const bottom = kindAt(0, 1);
  const left = kindAt(-1, 0);
  if (!top && !right && !bottom && !left) return;

  // Art pixels a vertical side paints inwards from its edge. Indoor against indoor is 2 px on
  // the left/top cell of the pair (threshold + shadow) but only 1 px on the right/bottom cell,
  // which has just a soft shadow there.
  const depth = (side: 'right' | 'left', kind: 'indoor' | 'grass' | null) => {
    if (!kind) return 0;
    if (selfIndoor && kind === 'indoor' && side === 'left') return 1;
    return 2;
  };
  const dR = depth('right', right);
  const dL = depth('left', left);

  // Corner rule: vertical sides always run the full cell height, and horizontal sides are
  // trimmed by the depth of the vertical side they meet. Each corner pixel is therefore painted
  // by exactly one strip, so two translucent shadows never stack into a dark notch.
  const h = (row: number, color: string, alpha: number) =>
    fxa(ctx, ox, oy, dL, row, ART - dL - dR, 1, color, alpha);
  const v = (col: number, color: string, alpha: number) =>
    fxa(ctx, ox, oy, col, 0, 1, ART, color, alpha);

  // Broken dither on the lawn: world-parity checkerboard, with about a quarter of the dots
  // dropped so the lip looks worn rather than ruled.
  const lawnDot = (i: number, j: number) => {
    const wc = x * ART + i;
    const wr = y * ART + j;
    if (((wc + wr) & 1) !== 0 || tileHash(wc, wr, 61) < 0.25) return;
    fxa(ctx, ox, oy, i, j, 1, 1, TILE.grass.shadow, 0.35);
  };

  if (selfIndoor) {
    // The top/left cell of a pair owns the metal threshold; the bottom/right cell only takes the
    // soft seam on its own edge. Trimmed horizontal strips never reach the corner (see above).
    if (top === 'grass') {
      h(0, OUTLINE, 0.45);
      h(1, AO, 0.15);
    } else if (top === 'indoor') {
      h(0, AO, 0.22);
    }
    if (bottom === 'grass') {
      h(ART - 1, OUTLINE, 0.45);
      h(ART - 2, AO, 0.15);
    } else if (bottom === 'indoor') {
      h(ART - 1, EDGE_TRIM, 1);
      h(ART - 2, AO, 0.18);
    }
    if (left === 'grass') {
      v(0, OUTLINE, 0.45);
      v(1, AO, 0.15);
    } else if (left === 'indoor') {
      v(0, AO, 0.22);
    }
    if (right === 'grass') {
      v(ART - 1, OUTLINE, 0.45);
      v(ART - 2, AO, 0.15);
    } else if (right === 'indoor') {
      v(ART - 1, EDGE_TRIM, 1);
      v(ART - 2, AO, 0.18);
    }
  } else {
    // Lawn beside a slab: a soil line on the edge, then broken dither for the next pixel.
    if (top === 'indoor') {
      h(0, SOIL, 0.55);
      for (let i = dL; i < ART - dR; i++) lawnDot(i, 1);
    }
    if (bottom === 'indoor') {
      h(ART - 1, SOIL, 0.55);
      for (let i = dL; i < ART - dR; i++) lawnDot(i, ART - 2);
    }
    if (left === 'indoor') {
      v(0, SOIL, 0.55);
      for (let j = 0; j < ART; j++) lawnDot(1, j);
    }
    if (right === 'indoor') {
      v(ART - 1, SOIL, 0.55);
      for (let j = 0; j < ART; j++) lawnDot(ART - 2, j);
    }
  }
}

/**
 * Smooth low-frequency wobble in art-pixel space, roughly +/-3px. Only used to bend the depth
 * bands: a distance field alone gives concentric squares around a rectangular pond, and the
 * wobble is what makes the contours look like a real bottom rather than a drawn frame.
 */
function waterNoise(wx: number, wy: number): number {
  const gx = wx / 8;
  const gy = wy / 8;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const sx = (gx - x0) ** 2 * (3 - 2 * (gx - x0));
  const sy = (gy - y0) ** 2 * (3 - 2 * (gy - y0));
  const v00 = tileHash(x0, y0, 113);
  const v10 = tileHash(x0 + 1, y0, 113);
  const v01 = tileHash(x0, y0 + 1, 113);
  const v11 = tileHash(x0 + 1, y0 + 1, 113);
  const top = v00 + (v10 - v00) * sx;
  const bottom = v01 + (v11 - v01) * sx;
  return ((top + (bottom - top) * sy) * 2 - 1) * 3;
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

      // Each board segment (the run between two butt joints) takes its own tone, so a row of
      // boards in the room no longer reads as one colour. Segments use the same period/phase
      // as the joints below, so the colour changes exactly where a joint is drawn.
      for (let j = 0; j < ART; j++) {
        const worldRow = y * ART + j;
        const plank = Math.floor(worldRow / PLANK_H);
        const rowInPlank = worldRow - plank * PLANK_H;
        const period = 64 + Math.floor(tileHash(0, plank, 7) * 64);
        const phase = Math.floor(tileHash(0, plank, 8) * period);
        const segOf = (i: number) => Math.floor((x * ART + i - phase) / period);

        let runStart = 0;
        for (let i = 1; i <= ART; i++) {
          if (i < ART && segOf(i) === segOf(runStart)) continue;
          fx(ctx, ox, oy, runStart, j, i - runStart, 1, tone(p, tileHash(segOf(runStart), plank, 3)));
          runStart = i;
        }

        // Top edge catches light, bottom edge falls into shade - translucent so each board
        // keeps its own colour underneath the seam.
        if (rowInPlank === 0) fxa(ctx, ox, oy, 0, j, ART, 1, p.light, 0.45);
        else if (rowInPlank === PLANK_H - 1) fxa(ctx, ox, oy, 0, j, ART, 1, p.shadow, 0.55);
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
      floorTransitions(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_carpet': {
      const p = TILE.carpet;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Tufted fleck texture: sparse single-pixel darks and lights drawn per world pixel, so the
      // nap reads as fabric with no lattice and no square blocks. Hashed in world space, so the
      // flecks run continuously across cell edges.
      for (let j = 0; j < ART; j++) {
        const wy = y * ART + j;
        for (let i = 0; i < ART; i++) {
          const wx = x * ART + i;
          const h = tileHash(wx, wy, 13);
          if (h < 0.10) fxa(ctx, ox, oy, i, j, 1, 1, p.shadow, 0.22);
          else if (h > 0.92) fxa(ctx, ox, oy, i, j, 1, 1, p.light, 0.2);
          // A very faint diagonal twill, barely visible under the flecks.
          if ((wx + wy) % 4 === 0) fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.07);
        }
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      floorTransitions(ctx, ox, oy, x, y, tiles);
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
          if (inX === 1 || inY === 1) fxa(ctx, ox, oy, i, j, 1, 1, p.light, 0.4);
          else if (inX === SLAB - 1 || inY === SLAB - 1) fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.35);
          else {
            // Faint veining, so a big expanse of stone isn't a field of identical squares.
            if (((worldCol * 3 + worldRow * 5) % 29) === Math.floor(tileHash(sx, sy, 23) * 29)) {
              fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.3);
            }
            // Gentle falloff away from the top-left light, so each slab reads as a polished surface.
            if (inX + inY >= 15) fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.1);
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
      floorTransitions(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_grass': {
      const p = TILE.grass;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Soft growth: a few small stepped clumps per cell, lighter growth more often than
      // thicker shade. Each clump is built from 1-px runs and kept inside the cell, so the
      // lawn reads as one green field with no square patches or hard seams.
      const clumps = 3 + Math.floor(tileHash(x, y, 150) * 3);
      for (let i = 0; i < clumps; i++) {
        const cx = 1 + Math.floor(tileHash(x, y, 160 + i) * (ART - 5));
        const cy = 1 + Math.floor(tileHash(x, y, 170 + i) * (ART - 4));
        const shape = Math.floor(tileHash(x, y, 180 + i) * 3);
        const lit = tileHash(x, y, 190 + i) < 0.6;
        const color = lit ? p.light : p.shadow;
        const alpha = lit ? 0.35 : 0.28;
        if (shape === 0) {
          // 3-px run over a 2-px run, stepped one pixel right
          fxa(ctx, ox, oy, cx, cy, 3, 1, color, alpha);
          fxa(ctx, ox, oy, cx + 1, cy + 1, 2, 1, color, alpha);
        } else if (shape === 1) {
          // small L tick
          fxa(ctx, ox, oy, cx + 1, cy, 1, 1, color, alpha);
          fxa(ctx, ox, oy, cx, cy + 1, 2, 1, color, alpha);
        } else {
          // diagonal step
          fxa(ctx, ox, oy, cx, cy, 1, 1, color, alpha);
          fxa(ctx, ox, oy, cx + 1, cy + 1, 1, 1, color, alpha);
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

      // Where the lawn meets water, a raised earth bank on the grass side. The darker row sits
      // against the water so the lip reads as sitting above it.
      if (tiles[y + 1]?.[x] === 'water') {
        fx(ctx, ox, oy, 0, ART - 2, ART, 1, '#6b5a3a');
        fx(ctx, ox, oy, 0, ART - 1, ART, 1, '#4e4129');
      }
      if (tiles[y]?.[x + 1] === 'water') {
        fx(ctx, ox, oy, ART - 2, 0, 1, ART, '#6b5a3a');
        fx(ctx, ox, oy, ART - 1, 0, 1, ART, '#4e4129');
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      floorTransitions(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'floor_concrete': {
      const p = TILE.concrete;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Soft aggregate: per-pixel grain in world space, so the slab texture runs continuously
      // across cell edges instead of stamping a 4px block grid into each cell.
      for (let j = 0; j < ART; j++) {
        const wy = y * ART + j;
        for (let i = 0; i < ART; i++) {
          const wx = x * ART + i;
          const h = tileHash(wx, wy, 41);
          if (h < 0.06) fxa(ctx, ox, oy, i, j, 1, 1, p.shadow, 0.25);
          else if (h > 0.95) fxa(ctx, ox, oy, i, j, 1, 1, p.hi, 0.22);
          else if (h < 0.14) fxa(ctx, ox, oy, i, j, 1, 1, p.dark, 0.1);
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

      // Rare hairline crack: a stepped diagonal, one pixel per step, kept inside the cell.
      if (tileHash(x, y, 300) > 0.93) {
        let cx = 2 + Math.floor(tileHash(x, y, 301) * 7); // start x in 2..8
        let cy = 3 + Math.floor(tileHash(x, y, 302) * 8); // start y in 3..10
        let dy = tileHash(x, y, 303) < 0.5 ? -1 : 1;
        const len = 5 + Math.floor(tileHash(x, y, 304) * 3); // 5..7 px
        for (let s = 0; s < len; s++) {
          fxa(ctx, ox, oy, cx, cy, 1, 1, p.shadow, 0.35);
          if (cy + dy < 1 || cy + dy > ART - 2) dy = -dy; // bounce off the cell edge
          cx += 1;
          cy += dy;
        }
      }

      // Rare faint stain: a small rounded blob, three stacked rects, in the cell interior.
      if (tileHash(x, y, 310) > 0.95) {
        const sx = 3 + Math.floor(tileHash(x, y, 311) * 7); // 3..9
        const sy = 3 + Math.floor(tileHash(x, y, 312) * 9); // 3..11
        fxa(ctx, ox, oy, sx + 1, sy, 4, 1, p.dark, 0.12);
        fxa(ctx, ox, oy, sx, sy + 1, 6, 2, p.dark, 0.12);
        fxa(ctx, ox, oy, sx + 1, sy + 3, 4, 1, p.dark, 0.12);
      }

      floorContactShadow(ctx, ox, oy, x, y, tiles);
      floorTransitions(ctx, ox, oy, x, y, tiles);
      break;
    }

    case 'asphalt': {
      const p = TILE.asphalt;
      fx(ctx, ox, oy, 0, 0, ART, ART, p.base);

      // Grit: sparse lighter and darker pixels, hashed on world position so the speckle is
      // deterministic and does not repeat per cell.
      for (let j = 0; j < ART; j++) {
        for (let i = 0; i < ART; i++) {
          const h = tileHash(x * ART + i, y * ART + j, 101);
          if (h > 0.9) fx(ctx, ox, oy, i, j, 1, 1, p.light);
          else if (h < 0.08) fx(ctx, ox, oy, i, j, 1, 1, p.dark);
        }
      }

      // Kerbs run along each edge that faces grass, walls or anything else that is not road or
      // pit lane. Three art pixels deep: the two outer rows take the block colour and the row
      // nearest the road takes its shade. Blocks are 4 art pixels long, alternate red and white,
      // and are keyed on world position, so the stripes run unbroken around corners and across
      // tile edges. Each kerb with a road side gets a 35% dark lip line just inside it. The lip
      // is skipped where the neighbouring kerb already covers that spot, so no shadow lands on
      // top of the other kerb in a corner.
      const KERB = 3;
      const kerbFacing = (nx: number, ny: number) => {
        const t = tiles[ny]?.[nx];
        return t !== undefined && t !== 'asphalt' && t !== 'floor_tile';
      };
      const kerbColours = (world: number): [string, string] =>
        Math.floor(world / 4) % 2 ? [KERB_WHITE, KERB_WHITE_SHADE] : [KERB_RED, KERB_RED_SHADE];
      const topKerb = kerbFacing(x, y - 1);
      const bottomKerb = kerbFacing(x, y + 1);
      const leftKerb = kerbFacing(x - 1, y);
      const rightKerb = kerbFacing(x + 1, y);

      if (topKerb) {
        for (let i = 0; i < ART; i++) {
          const [block, shade] = kerbColours(x * ART + i);
          fx(ctx, ox, oy, i, 0, 1, KERB - 1, block);
          fx(ctx, ox, oy, i, KERB - 1, 1, 1, shade);
        }
      }
      if (bottomKerb) {
        for (let i = 0; i < ART; i++) {
          const [block, shade] = kerbColours(x * ART + i);
          fx(ctx, ox, oy, i, ART - KERB + 1, 1, KERB - 1, block);
          fx(ctx, ox, oy, i, ART - KERB, 1, 1, shade);
        }
      }
      if (leftKerb) {
        for (let j = 0; j < ART; j++) {
          const [block, shade] = kerbColours(y * ART + j);
          fx(ctx, ox, oy, 0, j, KERB - 1, 1, block);
          fx(ctx, ox, oy, KERB - 1, j, 1, 1, shade);
        }
      }
      if (rightKerb) {
        for (let j = 0; j < ART; j++) {
          const [block, shade] = kerbColours(y * ART + j);
          fx(ctx, ox, oy, ART - KERB + 1, j, KERB - 1, 1, block);
          fx(ctx, ox, oy, ART - KERB, j, 1, 1, shade);
        }
      }

      // Lip shadows, one art pixel just inside each kerb. Each run stops short of any kerb that
      // runs across its end (the cross-kerb spans below).
      if (topKerb) {
        for (let i = leftKerb ? KERB : 0; i < (rightKerb ? ART - KERB : ART); i++) {
          fxa(ctx, ox, oy, i, KERB, 1, 1, OUTLINE, 0.35);
        }
      }
      if (bottomKerb) {
        for (let i = leftKerb ? KERB : 0; i < (rightKerb ? ART - KERB : ART); i++) {
          fxa(ctx, ox, oy, i, ART - KERB - 1, 1, 1, OUTLINE, 0.35);
        }
      }
      if (leftKerb) {
        for (let j = topKerb ? KERB : 0; j < (bottomKerb ? ART - KERB : ART); j++) {
          fxa(ctx, ox, oy, KERB, j, 1, 1, OUTLINE, 0.35);
        }
      }
      if (rightKerb) {
        for (let j = topKerb ? KERB : 0; j < (bottomKerb ? ART - KERB : ART); j++) {
          fxa(ctx, ox, oy, ART - KERB - 1, j, 1, 1, OUTLINE, 0.35);
        }
      }
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
      // Out-of-bounds cells count as water, so the map's outer edge doesn't grow a shoreline.
      const land: Array<{ dx: number; dy: number }> = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const t = tiles[y + dy]?.[x + dx];
          if ((dx !== 0 || dy !== 0) && t !== undefined && t !== 'water') land.push({ dx, dy });
        }
      }

      // Convex shore corners: where grass wraps a water corner (both orthogonal neighbours and the
      // diagonal between them), the corner is cut by a quarter circle instead of a square. Walls and
      // other floors keep hard corners, since a curve there would read as soft.
      const R = 6;
      const roundCorners = [
        { flipX: false, flipY: false, dx: -1, dy: -1 }, // NW
        { flipX: true, flipY: false, dx: 1, dy: -1 }, // NE
        { flipX: false, flipY: true, dx: -1, dy: 1 }, // SW
        { flipX: true, flipY: true, dx: 1, dy: 1 }, // SE
      ].filter(
        ({ dx, dy }) =>
          tiles[y + dy]?.[x + dx] === 'floor_grass' &&
          tiles[y]?.[x + dx] === 'floor_grass' &&
          tiles[y + dy]?.[x] === 'floor_grass'
      );

      // Distance from every art pixel to the nearest land rectangle, with diagonal cells included
      // so convex corners round off instead of stepping. `cast` is the same measure restricted to
      // land above or left of the pixel, since that's the land whose shadow falls onto the water.
      // Inside a rounded corner the land is the arc itself, so pixels measure to the arc.
      const DEPTH_CAP = 24;
      const depth = new Float32Array(ART * ART);
      const cast = new Float32Array(ART * ART);
      const cornerLand = new Uint8Array(ART * ART);
      const cornerBank = new Uint8Array(ART * ART);
      for (let j = 0; j < ART; j++) {
        for (let i = 0; i < ART; i++) {
          const k = j * ART + i;
          let inCorner = false;
          let isBank = false;
          let arcD = DEPTH_CAP;
          let arcCast = DEPTH_CAP;
          for (const c of roundCorners) {
            // Mirror into the corner's own frame so one quarter circle serves all four.
            const mi = c.flipX ? ART - 1 - i : i;
            const mj = c.flipY ? ART - 1 - j : j;
            if (mi >= R || mj >= R) continue;
            const dC = Math.hypot(mi + 0.5 - R, mj + 0.5 - R);
            if (dC > R) {
              inCorner = true;
              // Land pixels touching the water get the dark bank row, like the grass bank elsewhere.
              const waterRight = mi + 1 >= R || Math.hypot(mi + 1.5 - R, mj + 0.5 - R) <= R;
              const waterBelow = mj + 1 >= R || Math.hypot(mi + 0.5 - R, mj + 1.5 - R) <= R;
              if (waterRight || waterBelow) isBank = true;
            } else {
              const arc = R - dC;
              if (arc < arcD) arcD = arc;
              if ((c.dx < 0 || c.dy < 0) && arc < arcCast) arcCast = arc;
            }
          }
          if (inCorner) {
            cornerLand[k] = 1;
            if (isBank) cornerBank[k] = 1;
            continue;
          }

          const px = i + 0.5;
          const py = j + 0.5;
          let dAll = Math.min(DEPTH_CAP, arcD);
          let dCast = Math.min(DEPTH_CAP, arcCast);
          for (const { dx, dy } of land) {
            const x0 = dx * ART;
            const y0 = dy * ART;
            const ddx = Math.max(x0 - px, 0, px - (x0 + ART));
            const ddy = Math.max(y0 - py, 0, py - (y0 + ART));
            const d = Math.min(DEPTH_CAP, Math.hypot(ddx, ddy));
            if (d < dAll) dAll = d;
            if ((dx < 0 || dy < 0) && d < dCast) dCast = d;
          }
          depth[k] = dAll;
          cast[k] = dCast;
        }
      }

      // Deep core with rounded corners: pixels at least DARK_CORE deep are dilated by a small disc, so
      // the dark centre's corners are rounded instead of mitred like a rectangle's inset. Straight
      // edges still fall at about DARK_CORE - DARK_ROUND.
      const DARK_CORE = 13;
      const DARK_ROUND = 3;
      const deepCore = new Uint8Array(ART * ART);
      for (let j = 0; j < ART; j++) {
        for (let i = 0; i < ART; i++) {
          let near = false;
          for (let dj = -DARK_ROUND; dj <= DARK_ROUND && !near; dj++) {
            for (let di = -DARK_ROUND; di <= DARK_ROUND; di++) {
              if (di * di + dj * dj > DARK_ROUND * DARK_ROUND) continue;
              const qi = i + di;
              const qj = j + dj;
              if (qi < 0 || qj < 0 || qi >= ART || qj >= ART) continue;
              if (depth[qj * ART + qi] >= DARK_CORE) {
                near = true;
                break;
              }
            }
          }
          if (near) deepCore[j * ART + i] = 1;
        }
      }

      // Three solid tone bands: shallow light at the edge, base through the middle, dark in the
      // deepest centre. Band edges are bent by a wobble of about 1.5px (half of waterNoise's range)
      // and there is no dither, so the seams are clean tone changes. Shadow and foam below use the
      // raw distance so the shoreline stays crisp.
      for (let j = 0; j < ART; j++) {
        for (let i = 0; i < ART; i++) {
          const k = j * ART + i;
          const wx = x * ART + i;
          const wy = y * ART + j;
          if (cornerLand[k]) {
            fx(ctx, ox, oy, i, j, 1, 1, cornerBank[k] ? '#4e4129' : TILE.grass.base);
            continue;
          }
          const d = depth[k];
          const de = d + waterNoise(wx, wy) * 0.5;
          let c: string;
          if (de < 4) c = p.light;
          else if (deepCore[k] && de >= 10) c = p.dark;
          else c = p.base;
          fx(ctx, ox, oy, i, j, 1, 1, c);

          // Land above or left casts a 2px shadow onto the water, then the foam sits one pixel
          // beyond it. Without a cast shadow the foam sits one pixel out from the bank directly.
          const castD = cast[k];
          if (castD < 2) fxa(ctx, ox, oy, i, j, 1, 1, p.shadow, 0.45);
          const start = castD <= d + 0.01 ? 2 : 1;
          if (d >= start && d < start + 1) {
            fxa(ctx, ox, oy, i, j, 1, 1, p.hi, 0.7);
          } else if (d >= start + 1 && d < start + 2) {
            // Broken foam: about one pixel in three, placed by hash, so the line looks like wash.
            // There is no lattice here, so it cannot form a dither ring.
            if (tileHash(wx, wy, 83) < 0.33) fxa(ctx, ox, oy, i, j, 1, 1, p.hi, 0.45);
          }
        }
      }

      // Sparse ripples: short horizontal lines one step lighter than the water beneath, kept out
      // of the shore zone so they never read as a second foam line. Two per cell at most.
      for (let r = 0; r < 2; r++) {
        if (tileHash(x, y, 90 + r) < 0.5) continue;
        const ry = 4 + Math.floor(tileHash(x, y, 92 + r) * 9);
        const rx = Math.floor(tileHash(x, y, 94 + r) * 12);
        const rw = 2 + Math.floor(tileHash(x, y, 96 + r) * 2);
        for (let i = rx; i < rx + rw; i++) {
          const d = depth[ry * ART + i];
          if (d < 6) continue;
          fxa(ctx, ox, oy, i, ry, 1, 1, d < 12 ? p.light : p.base, 0.6);
        }
      }

      // Sparkles: at most two single pixels per cell, placed by hash and kept off the shore (depth > 6).
      for (let s = 0; s < 2; s++) {
        if (tileHash(x, y, 120 + s) < 0.5) continue;
        const sx = Math.floor(tileHash(x, y, 122 + s) * ART);
        const sy = Math.floor(tileHash(x, y, 124 + s) * ART);
        if (depth[sy * ART + sx] > 6) fx(ctx, ox, oy, sx, sy, 1, 1, p.hi);
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
    // Rows 3-12 keep the moving highlights clear of the north and south shore foam, which sits
    // in the outer two or three rows of the cell.
    const ry = 3 + Math.floor(seed * 10);
    const rx = ((Math.floor(seed * 7) + t) % 22) - 5;
    const rw = 4 + Math.floor(seed * 4);
    if (rx + rw <= 0 || rx >= ART) continue;
    const left = Math.max(rx, 0);
    const right = Math.min(rx + rw, ART);
    fxa(ctx, ox, oy, left, ry, right - left, 1, p.hi, 0.4);
    fxa(ctx, ox, oy, left + 1, ry - 1, Math.max(1, right - left - 2), 1, p.hi, 0.2);
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

/**
 * A portal is a flat swirl on the floor, not furniture, so it gets no contact shadow. It is
 * drawn per art pixel like everything else, so the ring edges stay on the grid, and animated
 * from Date.now(). Objects are redrawn every frame (they are not part of the terrain cache),
 * so the rotation needs no extra bookkeeping. Each pixel picks its colour from its distance
 * from the centre and, for the rings, its angle: segments rotate by shifting the angle sampled
 * over time, so the pattern turns without any pixel having to move.
 */
function renderPortal(ctx: CanvasRenderingContext2D, obj: MapObject) {
  const ox = obj.x * CELL_SIZE;
  const oy = obj.y * CELL_SIZE;
  const W = (obj.width || 1) * ART;
  const H = (obj.height || 1) * ART;
  const cx = W / 2;
  const cy = H / 2;
  const mid = W / 2;
  const t = Date.now() / 1000;
  const TAU = Math.PI * 2;
  const wrap = (v: number) => ((v % TAU) + TAU) % TAU;
  // Centre pulse: the plus-shaped ring around the core toggles on and off twice a second.
  const pulseOn = Math.floor(t * 2) % 2 === 1;

  ctx.save();
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const dx = i + 0.5 - cx;
      const dy = j + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > 8) continue;
      const a = Math.atan2(dy, dx);

      if (d > 7) {
        // Glow: a checkerboard dither of violet, so it reads as light pooled on the floor.
        if ((i + j) % 2 === 0) fxa(ctx, ox, oy, i, j, 1, 1, '#b98cf0', 0.35);
      } else if (d > 5.4) {
        // Outer ring: 8 segments turning clockwise (angle sampled at a - 1.2t).
        const seg = Math.floor(wrap(a - 1.2 * t) / (TAU / 8));
        let colour = seg % 2 === 0 ? '#8f5fe0' : '#c9a6ff';
        // The lower-right of the outer edge sits in shadow, which gives the ring some depth.
        if (d > 6.5 && dx + dy > 0) colour = '#5b3aa8';
        fx(ctx, ox, oy, i, j, 1, 1, colour);
      } else if (d > 4.4) {
        fx(ctx, ox, oy, i, j, 1, 1, '#1c1438'); // dark gap between the rings
      } else if (d > 2.8) {
        // Inner ring: 6 segments turning counter-clockwise (angle sampled at a + 2t).
        const seg = Math.floor(wrap(a + 2 * t) / (TAU / 6));
        fx(ctx, ox, oy, i, j, 1, 1, seg % 2 === 0 ? '#2fb5c8' : '#8ef0f5');
      } else {
        // Core. The 2x2 centre block is white, with a plus-shaped ring of 1px around it that
        // blinks in and out.
        const inCentre = (i === mid - 1 || i === mid) && (j === mid - 1 || j === mid);
        const edgeI = i === mid - 2 || i === mid + 1;
        const edgeJ = j === mid - 2 || j === mid + 1;
        const inRing =
          i >= mid - 2 && i <= mid + 1 && j >= mid - 2 && j <= mid + 1 && !(edgeI && edgeJ);
        let colour = '#1c1438';
        if (inCentre) colour = '#ffffff';
        else if (inRing && pulseOn) colour = '#c9a6ff';
        fx(ctx, ox, oy, i, j, 1, 1, colour);
      }
    }
  }
  ctx.restore();
}

/** Floating name over a portal, drawn after the avatars so it is never hidden behind them. */
function renderPortalLabel(ctx: CanvasRenderingContext2D, obj: MapObject) {
  const label = obj.data?.label || obj.name || 'Portal';
  const cx = (obj.x + (obj.width || 1) / 2) * CELL_SIZE;
  const top = obj.y * CELL_SIZE;

  ctx.save();
  ctx.font = 'bold 11px "Silkscreen", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const boxW = ctx.measureText(label).width + 14;
  const boxH = 18;
  const bx = cx - boxW / 2;
  const by = top - boxH - 6;
  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeStyle = '#c084fc';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, boxW, boxH);
  ctx.fillStyle = '#f5f3ff';
  ctx.fillText(label, cx, by + boxH / 2 + 1);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Tire barrier sprite
// ---------------------------------------------------------------------------
// A stack of tires seen from above, filling the tile. Barriers are numerous (hundreds on the race
// track) and objects are redrawn every frame, so each colour variant is rasterised once into an
// offscreen tile and blitted. The painted band alternates red and white by tile parity, like the
// striped barriers on real circuits.

const TIRE_CONTACT = 'rgba(11, 18, 32, 0.35)';
const TIRE_RUBBER = '#262b38';
const TIRE_RUBBER_NOTCH = '#2f3544';
const TIRE_RUBBER_LIT = '#3a4152';
const TIRE_RUBBER_NOTCH_LIT = '#323848';
const TIRE_BANDS = ['#c94a3d', '#ece7dc'] as const;
const TIRE_SIDEWALL = '#1a1e29';
const TIRE_SIDEWALL_FAR = '#2f3544';
const TIRE_HOLE = '#0b0f19';

let tireSprites: HTMLCanvasElement[] | null = null;

function drawTireSprite(band: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_SIZE;
  canvas.height = CELL_SIZE;
  const tctx = canvas.getContext('2d')!;
  const centre = ART / 2;
  for (let py = 0; py < ART; py++) {
    for (let px = 0; px < ART; px++) {
      // Distance and angle of this art pixel's centre from the middle of the tile. The bands
      // are rings, so every edge is a distance threshold; the tread notches are angular.
      const dx = px + 0.5 - centre;
      const dy = py + 0.5 - centre;
      const d = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      // Light comes from the top-left: that half of the tyre is lifted, and the far inner wall
      // on the bottom-right catches light instead of falling into the hole.
      const lit = px + py < 15;
      const farSide = px + py > 16;
      let colour: string | null = null; // null: beyond the stack, the floor shows through
      if (d > 7.2) {
        if (d <= 8 && farSide) colour = TIRE_CONTACT; // soft contact shadow on the bottom-right
      } else if (d > 6.4) {
        colour = OUTLINE;
      } else if (d > 4.6) {
        // Every other 22.5-degree sector is a notch, which reads as tread.
        const notch = Math.floor((a + Math.PI) / (Math.PI / 8)) % 2 === 1;
        if (lit) colour = notch ? TIRE_RUBBER_NOTCH_LIT : TIRE_RUBBER_LIT;
        else colour = notch ? TIRE_RUBBER_NOTCH : TIRE_RUBBER;
      } else if (d > 3.8) {
        colour = band;
      } else if (d > 2.6) {
        colour = farSide ? TIRE_SIDEWALL_FAR : TIRE_SIDEWALL;
      } else {
        colour = TIRE_HOLE;
      }
      if (colour) fx(tctx, 0, 0, px, py, 1, 1, colour);
    }
  }
  return canvas;
}

function tireSprite(x: number, y: number): HTMLCanvasElement {
  if (!tireSprites) tireSprites = TIRE_BANDS.map((band) => drawTireSprite(band));
  return tireSprites[(x + y) & 1];
}

function renderObject(ctx: CanvasRenderingContext2D, obj: MapObject) {
  if (obj.type === 'portal') {
    renderPortal(ctx, obj);
    return;
  }

  const ox = obj.x * CELL_SIZE;
  const oy = obj.y * CELL_SIZE;
  const W = (obj.width || 1) * ART; // object width in art pixels
  const H = (obj.height || 1) * ART;

  ctx.save();

  // Contact shadow. Two bands rather than one flat block: a tight, darker core right under
  // the object and a wider soft skirt, which is what sits a sprite *on* the floor instead of
  // hovering it over a grey rectangle. Matches the light direction used everywhere else.
  // Tire barriers fill their tile, and the start line and track arrows are painted on the road,
  // so none of them has a visible floor shadow and they skip it.
  if (obj.type !== 'tires' && obj.type !== 'finish_line' && obj.type !== 'track_arrow') {
    fx(ctx, ox, oy, 1, H - 2, W - 1, 2, 'rgba(20, 26, 44, 0.38)');
    fx(ctx, ox, oy, 2, H, W - 1, 1, 'rgba(20, 26, 44, 0.16)');
    fx(ctx, ox, oy, W - 2, 2, 2, H - 2, 'rgba(20, 26, 44, 0.22)');
  }

  switch (obj.type) {
    case 'tires': {
      ctx.drawImage(tireSprite(obj.x, obj.y), ox, oy);
      break;
    }

    case 'finish_line': {
      // 4-pixel checks, so four columns fit across a 16-wide tile. Dark 40% edges down the left
      // and right of the strip bound the line against the road instead of letting the checks
      // run straight into the asphalt.
      const CHECK = 4;
      for (let j = 0; j < H / CHECK; j++) {
        for (let i = 0; i < W / CHECK; i++) {
          fx(ctx, ox, oy, i * CHECK, j * CHECK, CHECK, CHECK, (i + j) % 2 ? '#efeae0' : '#151a24');
        }
      }
      fxa(ctx, ox, oy, 0, 0, 1, H, OUTLINE, 0.4);
      fxa(ctx, ox, oy, W - 1, 0, 1, H, OUTLINE, 0.4);
      break;
    }

    case 'track_arrow': {
      // A faint chevron painted on the road, pointing the way the race runs. Authored once as a
      // right-pointing mask and mapped onto the other directions, so the tip always lands on the
      // edge it points at. Translucent, so the road grit still shows through the paint.
      const MASK = [
        '................',
        '................',
        '................',
        '....###.........',
        '.....###........',
        '......###.......',
        '.......###......',
        '.........###....',
        '.........###....',
        '.......###......',
        '......###.......',
        '.....###........',
        '....###.........',
        '................',
        '................',
        '................',
      ];
      const dir = obj.data?.dir ?? 'right';
      for (let j = 0; j < ART; j++) {
        for (let i = 0; i < ART; i++) {
          if (MASK[j][i] !== '#') continue;
          // Mask cell (i, j) to drawn cell. For 'down' the tip (largest i) maps to the bottom row;
          // for 'up' it maps to the top row.
          const [dx, dy] =
            dir === 'down' ? [ART - 1 - j, i]
            : dir === 'left' ? [ART - 1 - i, j]
            : dir === 'up' ? [j, ART - 1 - i]
            : [i, j];
          fxa(ctx, ox, oy, dx, dy, 1, 1, '#e8e4d8', 0.45);
        }
      }
      break;
    }

    case 'desk': {
      const isClaimed = !!obj.data?.deskState?.claimedByUserId;
      const wood: Ramp = isClaimed ? PALETTE.amber : PALETTE.oak;
      const steel = PALETTE.steel;
      const cx = Math.floor(W / 2);

      // Desk top: an outlined slab from y=1 down to H-5, lit along the back and left, shaded on the right.
      const topX = 1;
      const topY = 1;
      const topW = W - 2;
      const topH = H - 5;
      fx(ctx, ox, oy, topX, topY, topW, topH, wood.base);
      fx(ctx, ox, oy, topX + 1, topY + 1, topW - 2, 1, wood.light); // lit back rim
      fx(ctx, ox, oy, topX + 1, topY + 1, 1, topH - 2, wood.light); // lit left rim
      fx(ctx, ox, oy, topX + topW - 2, topY + 1, 1, topH - 2, wood.dark); // shaded right edge
      ox1(ctx, ox, oy, topX, topY, topW, topH, OUTLINE);
      // Faint grain: two short dashes, in spots the equipment does not cover.
      fxa(ctx, ox, oy, W - 5, 4, 2, 1, wood.dark, 0.3);
      fxa(ctx, ox, oy, cx - 12, 9, 3, 1, wood.dark, 0.25);

      // Front apron: a wood.dark face with an ink bottom line, so the desk has thickness.
      const apronY = H - 4;
      fx(ctx, ox, oy, topX, apronY, topW, 1, wood.dark);
      fx(ctx, ox, oy, topX, apronY + 1, topW, 1, OUTLINE);
      fx(ctx, ox, oy, topX, apronY, 1, 1, OUTLINE);
      fx(ctx, ox, oy, topX + topW - 1, apronY, 1, 1, OUTLINE);

      // Two short legs under the apron, one at each end, with a faint contact shadow between them.
      const legY = H - 2;
      const legL = topX + 2;
      const legR = topX + topW - 4;
      for (const lx of [legL, legR]) {
        fx(ctx, ox, oy, lx, legY, 2, 1, wood.dark);
        fx(ctx, ox, oy, lx, legY + 1, 2, 1, OUTLINE);
      }
      fxa(ctx, ox, oy, legL + 2, legY, legR - legL - 2, 1, AO, 0.3);

      // Shared pieces: the bezel-and-screen monitor, its stand, a key block and a mouse.
      const drawMonitor = (
        x: number,
        y: number,
        w: number,
        h: number,
        screenDark: string,
        lines: [number, number, number, string][]
      ) => {
        // Bezel: steel.base with a lit top-left and a shaded bottom-right, inside an ink outline.
        fx(ctx, ox, oy, x, y, w, h, steel.base);
        fx(ctx, ox, oy, x + 1, y + 1, w - 2, 1, steel.light);
        fx(ctx, ox, oy, x + 1, y + 1, 1, h - 2, steel.light);
        fx(ctx, ox, oy, x + w - 2, y + 1, 1, h - 2, steel.dark);
        fx(ctx, ox, oy, x + 1, y + h - 2, w - 2, 1, steel.dark);
        ox1(ctx, ox, oy, x, y, w, h, OUTLINE);
        // Screen: one glare pixel at the top-left, then short code lines.
        const sx = x + 2;
        const sy = y + 2;
        fx(ctx, ox, oy, sx, sy, w - 4, h - 4, screenDark);
        fx(ctx, ox, oy, sx, sy, 1, 1, mixHex(screenDark, '#ffffff', 0.4));
        for (const [lx, ly, len, color] of lines) fx(ctx, ox, oy, sx + lx, sy + ly, len, 1, color);
        return { sx, sy };
      };
      const drawStand = (c: number, my: number) => {
        fx(ctx, ox, oy, c - 1, my, 2, 1, steel.base); // neck
        fx(ctx, ox, oy, c - 3, my + 1, 6, 1, steel.dark); // foot
      };
      const RGB = [ACCENT.pink, ACCENT.teal, ACCENT.lime];
      const drawKeys = (kx: number, ky: number, kw: number, kh: number, rgb = false) => {
        fx(ctx, ox, oy, kx, ky, kw, kh, steel.light);
        // Key dots on each interior row, offset every other row for a 2-row pattern.
        for (let r = 1; r < kh - 1; r++) {
          for (let i = kx + 1 + (r % 2); i < kx + kw - 2; i += 2) fx(ctx, ox, oy, i, ky + r, 1, 1, steel.dark);
        }
        if (rgb) for (let i = kx + 1; i < kx + kw - 1; i++) fx(ctx, ox, oy, i, ky + 1, 1, 1, RGB[i % 3]);
        ox1(ctx, ox, oy, kx, ky, kw, kh, OUTLINE);
      };
      const drawMouse = (mx: number, my: number) => {
        fx(ctx, ox, oy, mx, my, 3, 3, steel.light);
        ox1(ctx, ox, oy, mx, my, 3, 3, OUTLINE);
      };

      // Layout: screens sit on the back edge (rows 0..6), stands below them (row 7), and the keys
      // and mouse in front (rows 8..10). Everything is centred on cx.
      const equipment = obj.data?.deskState?.equipment || 'laptop';
      const monY = 0;
      const monH = 7;
      const standY = monY + monH;
      const kbW = 12;
      const kbX = cx - 6;
      const kbY = 8;

      if (equipment === 'dual_monitors') {
        // Two monitors with a 1 px gap on the centre line.
        drawMonitor(cx - 10, monY, 10, monH, PALETTE.water.dark, [
          [1, 1, 4, PALETTE.water.hi],
          [1, 2, 3, ACCENT.pink],
        ]);
        drawMonitor(cx + 1, monY, 10, monH, PALETTE.indigo.dark, [
          [1, 1, 4, PALETTE.indigo.hi],
          [1, 2, 2, ACCENT.lime],
        ]);
        drawStand(cx - 5, standY);
        drawStand(cx + 6, standY);
        drawKeys(kbX, kbY, kbW, 3);
      } else if (equipment === 'designer_tablet') {
        // One wide monitor with colour swatches, and a dark pen tablet with a stylus front-left.
        const scr = drawMonitor(cx - 10, monY, 20, monH, '#1f2a3a', []);
        [ACCENT.red, ACCENT.yellow, ACCENT.teal, ACCENT.violet].forEach((c, i) =>
          fx(ctx, ox, oy, scr.sx + 1 + i * 4, scr.sy + 1, 3, 2, c)
        );
        drawStand(cx, standY);
        drawKeys(kbX, kbY, kbW, 3);
        const tabX = kbX - 7;
        fx(ctx, ox, oy, tabX, kbY, 6, 3, '#2b3345');
        ox1(ctx, ox, oy, tabX, kbY, 6, 3, OUTLINE);
        fx(ctx, ox, oy, tabX + 6, kbY + 1, 3, 1, steel.hi); // stylus
      } else if (equipment === 'gaming_rig') {
        // Faint pink RGB spill around the monitor (one px past each side, not on the desk edge).
        fxa(ctx, ox, oy, cx - 11, monY, 22, monH, ACCENT.pink, 0.22);
        drawMonitor(cx - 10, monY, 20, monH, '#3f3663', [
          [1, 1, 12, ACCENT.pink],
          [1, 2, 7, ACCENT.teal],
          [9, 2, 4, ACCENT.lime],
        ]);
        drawStand(cx, standY);
        drawKeys(kbX, kbY, kbW, 3, true);
      } else {
        // Laptop: a lid over a light-steel deck, and the deck doubles as the keyboard.
        drawMonitor(cx - 5, monY, 10, monH, PALETTE.water.dark, [
          [1, 1, 4, PALETTE.water.hi],
          [1, 2, 3, ACCENT.cream],
        ]);
        drawKeys(kbX, standY, kbW, 4);
      }
      drawMouse(kbX + kbW + 1, kbY);

      if (W >= 32) {
        // Succulent in a small pot, top-left.
        drawMask(
          ctx,
          ox,
          oy,
          ['.g.', 'gGg', 'GgG', 'oPo', 'ooo'],
          { g: PALETTE.leaf.light, G: PALETTE.leaf.base, o: OUTLINE, P: ACCENT.orange },
          2,
          2
        );
        // Mug: top-right when it clears the right-hand monitor, otherwise beside the mouse.
        const mugX = W - 6;
        const mugY = mugX > cx + 11 ? 2 : 7;
        shadedBlock(ctx, ox, oy, mugX, mugY, 3, 4, { dark: '#a8473a', base: ACCENT.red, light: '#eb8a78', hi: '#f6b8ab' });
        fx(ctx, ox, oy, mugX + 1, mugY + 1, 1, 1, '#6b4526'); // coffee
        fx(ctx, ox, oy, mugX + 3, mugY + 1, 1, 2, ACCENT.red); // handle
      }

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
      // Office chair seen from above, light from the top-left: an indigo backrest at the top
      // (rim, face, and a shadowed right edge), a lighter indigo seat cushion below it, steel
      // armrests and gas lift, and a splayed steel base with two castors peeking out below it.
      // Palette keys: o ink outline; L/k/d backrest (rim, face, shadow edge); h/s/b seat (top
      // highlight, face, shadow edge); M/m/n steel (light, base, dark) for arms, lift and base.
      const chairEdge = mixHex(PALETTE.indigo.dark, OUTLINE, 0.4); // darker indigo for the backrest's shadow edge

      // Office chair from above, in art pixels.
      drawMask(
        ctx,
        ox,
        oy,
        [
          '....oooooooo....',
          '...oLLLLLLLLo...',
          '..oLkkkkkkkkdo..',
          '..oLkkkkkkkkdo..',
          '..oLkkkkkkkkdo..',
          '..oooooooooooo..',
          'oMohhhhhhhhhhono',
          'oMosssssssssbono',
          'oMosssssssssbono',
          'oMosssssssssbono',
          'oMobbbbbbbbbbono',
          '.oooooooooooooo.',
          '......oMno......',
          '......omno......',
          '..M.m.Mmmn.n.n..',
          '.onno......onno.',
        ],
        {
          o: OUTLINE,
          L: PALETTE.indigo.base,
          k: PALETTE.indigo.dark,
          d: chairEdge,
          h: PALETTE.indigo.hi,
          s: PALETTE.indigo.light,
          b: PALETTE.indigo.base,
          M: PALETTE.steel.light,
          m: PALETTE.steel.base,
          n: PALETTE.steel.dark,
        },
        Math.floor((W - 16) / 2),
        H - 16
      );
      break;
    }

    case "conference_table": {
      const tableP = PALETTE.darkwood;
      const steelP = PALETTE.steel;

      // The old art was a plain rectangle with a row of stubby blocks above and below it,
      // which read as a bench rather than a meeting table and never made it obvious how
      // many people it seats. It is now drawn as a real boardroom table: seats on all four
      // sides (each an actual chair with a backrest and a shadow), a chamfered top
      // with a lighter inlay, a cable tray with grommets down the middle, and a few props.
      const seatsPerSide = Math.max(2, Math.round(W / 16));
      const CHAIR_W = 8;
      const CHAIR_D = 5; // depth: backrest + seat

      /**
       * One chair, in art pixels, facing the table. `side` decides which way the backrest
       * sits relative to the seat, so the same routine serves all four edges.
       */
      function drawChair(cx: number, cy: number, side: 'top' | 'bottom' | 'left' | 'right') {
        // Outlined office chair, drawn as a mask. The top-facing chair is the source of truth:
        // its backrest is on the far side from the table. The other three are derived from it.
        const top = [
          '.oooooo.',
          'oLLLLLLo',
          'okkkkkdo',
          'oohhhhoo',
          'osssssbo',
          '.oooooo.',
        ];
        const transpose = (rows: string[]) =>
          rows[0].split('').map((_, c) => rows.map((r) => r[c]).join(''));
        const masks = {
          top,
          bottom: [...top].reverse(),
          left: transpose(top),
          right: transpose(top).map((r) => r.split('').reverse().join('')),
        };
        const mask = masks[side];

        // Contact shadow: one row just under the mask's bottom edge, drawn before the mask. It is
        // skipped when that row would fall outside the object, so it never draws past H.
        if (cy + mask.length < H) {
          fx(ctx, ox, oy, cx + 1, cy + mask.length, mask[0].length - 2, 1, 'rgba(20, 26, 44, 0.28)');
        }

        drawMask(
          ctx,
          ox,
          oy,
          mask,
          {
            o: OUTLINE,
            L: PALETTE.indigo.base, // backrest rim
            k: PALETTE.indigo.dark, // backrest face
            d: mixHex(PALETTE.indigo.dark, OUTLINE, 0.4), // backrest shadow edge
            h: PALETTE.indigo.hi, // seat highlight
            s: PALETTE.indigo.light, // seat cushion
            b: PALETTE.indigo.base, // seat shadow edge
          },
          cx,
          cy
        );
      }

      const marginX = 3;
      const marginY = CHAIR_D + 1;
      const tw = W - marginX * 2;
      const th = H - marginY * 2;

      // Seats along the long edges.
      const spacing = tw / seatsPerSide;
      for (let i = 0; i < seatsPerSide; i++) {
        const cx = Math.floor(marginX + i * spacing + spacing / 2 - CHAIR_W / 2);
        drawChair(cx, 0, 'top');
        drawChair(cx, H - CHAIR_D - 1, 'bottom');
      }

      // Head-of-table seats, only where there is actually room for them.
      const hasEndSeats = th >= CHAIR_W + 2 && marginX >= CHAIR_D - 1;
      if (hasEndSeats) {
        const cy = marginY + Math.floor((th - CHAIR_W) / 2);
        drawChair(0, cy, 'left');
        drawChair(W - CHAIR_D - 1, cy, 'right');
      }

      // Drop shadow under the top, then the top itself.
      fx(ctx, ox, oy, marginX, marginY + 1, tw, th, OUTLINE);
      shadedBlock(ctx, ox, oy, marginX, marginY, tw, th, tableP);

      // Chamfered corners: knock a pixel out of each corner and re-outline it, which is how
      // a rounded boardroom top reads at this resolution.
      [
        [marginX, marginY],
        [marginX + tw - 1, marginY],
        [marginX, marginY + th - 1],
        [marginX + tw - 1, marginY + th - 1],
      ].forEach(([px, py]) => fx(ctx, ox, oy, px, py, 1, 1, OUTLINE));

      // Inlay panel - a lighter band inset from the edge, the way veneered tops are banded.
      if (tw > 10 && th > 6) {
        fx(ctx, ox, oy, marginX + 2, marginY + 2, tw - 4, th - 4, tableP.light);
        ox1(ctx, ox, oy, marginX + 2, marginY + 2, tw - 4, th - 4, tableP.dark);
        dither(ctx, ox, oy, marginX + 3, marginY + 3, tw - 6, th - 6, tableP.base, 1);
      }

      // Cable tray with grommets down the spine of the table.
      if (tw > 14 && th > 8) {
        const trayW = Math.floor(tw * 0.55);
        const trayH = Math.max(3, Math.floor(th * 0.3));
        const trayX = marginX + Math.floor((tw - trayW) / 2);
        const trayY = marginY + Math.floor((th - trayH) / 2);
        shadedBlock(ctx, ox, oy, trayX, trayY, trayW, trayH, steelP);
        fx(ctx, ox, oy, trayX + 1, trayY + 1, trayW - 2, trayH - 2, steelP.dark);
        for (let gx = trayX + 2; gx < trayX + trayW - 2; gx += 4) {
          fx(ctx, ox, oy, gx, trayY + 1, 1, 1, steelP.hi);
        }
      }

      // Props: a laptop, a notepad and a mug, placed deterministically off the object's own
      // tile so a given table always looks the same rather than shuffling every repaint.
      if (tw > 18 && th > 8) {
        const roll = tileHash(obj.x, obj.y, 7);
        const propY = marginY + 2;

        // Open laptop, lid up, at the left seat.
        fx(ctx, ox, oy, marginX + 3, propY, 6, 3, ACCENT.ink);
        fx(ctx, ox, oy, marginX + 4, propY + 1, 4, 1, ACCENT.sky);
        fx(ctx, ox, oy, marginX + 3, propY + 3, 6, 1, steelP.light);

        // Notepad on the far side.
        fx(ctx, ox, oy, marginX + tw - 10, marginY + th - 5, 6, 3, ACCENT.cream);
        ox1(ctx, ox, oy, marginX + tw - 10, marginY + th - 5, 6, 3, OUTLINE);
        fx(ctx, ox, oy, marginX + tw - 9, marginY + th - 4, 4, 1, steelP.base);

        // Mug, on whichever side the hash picks.
        const mugX = roll > 0.5 ? marginX + tw - 6 : marginX + 4;
        const mugY = roll > 0.5 ? propY : marginY + th - 5;
        fx(ctx, ox, oy, mugX, mugY, 3, 3, roll > 0.5 ? ACCENT.red : ACCENT.teal);
        ox1(ctx, ox, oy, mugX, mugY, 3, 3, OUTLINE);
        fx(ctx, ox, oy, mugX + 1, mugY + 1, 1, 1, ACCENT.cream);
      }

      break;
    }

    case 'plant': {
      // Terracotta ramp for the pot, shadow (P) to highlight (r).
      const TERRACOTTA = {
        P: '#8c4a32',
        p: '#b8653f',
        q: '#d0805a',
        r: '#e8a57c',
      };
      const leaf = PALETTE.leaf;

      // Leafy monstera fronds separated by ink veins, light from the top-left, over a terracotta pot.
      drawMask(
        ctx,
        ox,
        oy,
        [
          '......oo.oo.....',
          '....ooLLoHLo....',
          '...oLLBoLLBBoo..',
          '..oLHBBoBBBoLLo.',
          '.oBLBBDoBDooLBBo',
          '.oBBBDoLLBoLHBBo',
          'oLBBDoLHBBBoBBDo',
          'oLLBDoLBBBDoBDo.',
          'oLBBBoBBBDDoDDo.',
          '.oBDDoDBDDooDo..',
          '..oooooooooooo..',
          '..oqrqqqqqqqqo..',
          '..oppppppppPPo..',
          '...oqppppppPo...',
          '...orpppppPPo...',
          '....oooooooo....',
        ],
        {
          o: OUTLINE,
          D: leaf.dark,
          B: leaf.base,
          L: leaf.light,
          H: leaf.hi,
          ...TERRACOTTA,
        },
        Math.floor((W - 16) / 2),
        H - 16
      );
      break;
    }

    case 'computer': {
      // A compact one-tile computer station in the desk's 3/4 view: a small oak side-desk, a
      // front-facing monitor on its back half, keys and a mouse in front, and a PC tower on the floor
      // beside the desk at the right end. Palette keys: o outline, T/B/D oak light/base/dark,
      // L/b/n steel light/base/dark, S screen, g glare, l/c code lines, G power LED.
      const steel = PALETTE.steel;
      const wood = PALETTE.oak;
      const dx = Math.floor((W - 16) / 2);
      const dy = H - 16;

      drawMask(
        ctx,
        ox,
        oy,
        [
          '................',
          '.oooooooooo.....',
          '.oLLLLLLLno.....',
          '.oLgSSSSSno.....',
          'ooLSlllSSnoo....',
          'ooLSccSSSnoo....',
          'oonnnnnnnnoooooo',
          'oooooooooooooLLo',
          'oTBBobboBBBooLGo',
          'oTooooooBLLooLno',
          'oBoLnLnoBbnoonno',
          'oBooooooBBBooLno',
          'oTBBBBBBBBBoonno',
          'oDDDDDDDDDDooLno',
          'oooooooooooooLno',
          '.DD......DD.oooo',
        ],
        {
          o: OUTLINE,
          T: wood.light,
          B: wood.base,
          D: wood.dark,
          L: steel.light,
          b: steel.base,
          n: steel.dark,
          S: PALETTE.water.dark,
          g: PALETTE.water.hi,
          l: ACCENT.lime,
          c: ACCENT.sky,
          G: ACCENT.green,
        },
        dx,
        dy
      );

      // Soft contact shadow on the floor under the desk, drawn after the mask so it sits on top of the floor.
      fxa(ctx, ox, oy, dx + 3, dy + 15, 6, 1, AO, 0.3);
      break;
    }

    case 'whiteboard': {
      // Steel frame around a cool-white board, a marker tray along the bottom edge, and doodles
      // inside the board's inner rect. Everything is laid out from W and H, and each doodle is only
      // drawn when its own width and height check against the zone passes, so small boards drop
      // doodles instead of overflowing.
      const BOARD = '#eef1f4';
      const BOARD_TOP = '#f8fafb';
      const BOARD_EDGE = '#d5dde6';
      const BASELINE = '#7d8798';

      // Frame: steel block over rows 0..H-4, same footprint as before.
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 3, PALETTE.steel);

      // Board: inset 2 art px from the frame on every side, with a lit top row and a cool inner edge
      // on the right and bottom.
      const bx = 2;
      const by = 2;
      const bw = W - 4;
      const bh = H - 7;
      fx(ctx, ox, oy, bx, by, bw, bh, BOARD);
      fx(ctx, ox, oy, bx, by, bw, 1, BOARD_TOP);
      fx(ctx, ox, oy, bx + bw - 1, by, 1, bh, BOARD_EDGE);
      fx(ctx, ox, oy, bx, by + bh - 1, bw, 1, BOARD_EDGE);

      // Doodle zone: starts 1 art px inside the board's top highlight row and never reaches the cool
      // right and bottom edge rows, so the zone stays clear of the board edges and above the tray.
      // At 32x16 this is cols 3..28, rows 3..9.
      const zx0 = bx + 1;
      const zx1 = bx + bw - 1;
      const zy0 = by + 1;
      const zy1 = by + bh - 1;
      const zw = zx1 - zx0;
      const zh = zy1 - zy0;

      // Bar chart on the left. Its baseline takes the zone's last row, so the tallest bar is zh - 1.
      const barCount = zw >= 11 ? 4 : 3;
      const barsW = barCount * 3 - 1;
      const barsFit = zw >= 8 && zh >= 2;
      if (barsFit) {
        const maxBar = zh - 1;
        const pattern = maxBar >= 7 ? [3, 5, 4, 7] : maxBar >= 6 ? [3, 5, 4, 6] : [2, 4, 1, 3];
        const heights = pattern.map((h) => Math.min(h, maxBar));
        const barColors = [ACCENT.red, ACCENT.green, ACCENT.blue, ACCENT.yellow];
        const baseY = zy1 - 1;
        fx(ctx, ox, oy, zx0, baseY, barsW, 1, BASELINE);
        for (let i = 0; i < barCount; i++) {
          const color = barColors[i];
          const h = heights[i];
          const x = zx0 + i * 3;
          fx(ctx, ox, oy, x, baseY - h, 1, h, color);
          fx(ctx, ox, oy, x + 1, baseY - h, 1, h, mixHex(color, OUTLINE, 0.45));
        }
      }

      // Sticky flow and squiggle to the right of the bars. The squiggle drops first, then the flow.
      const gx = barsFit ? zx0 + barsW + 1 : zx0;
      const gw = zx1 - gx;
      const stickyFits = gw >= 12 && zh >= 3;
      // The squiggle keeps one clear board row below the sticky flow, so it needs a 7-row zone when
      // the flow is drawn. At 32x16 the zone is 7 rows, which fits the flow, a gap row and the wave.
      const squiggleTop = stickyFits ? zy0 + 4 : zy0;
      const squiggleFits = gw >= 11 && squiggleTop + 3 <= zy1;
      if (stickyFits) {
        const sy = zy0;
        const ink = ACCENT.blue;
        // Two 4x3 boxes with a pale fill, joined by a 1 px connector and an arrowhead pointing at box B.
        fx(ctx, ox, oy, gx, sy, 4, 3, ACCENT.yellow);
        ox1(ctx, ox, oy, gx, sy, 4, 3, ink);
        fx(ctx, ox, oy, gx + 8, sy, 4, 3, ACCENT.yellow);
        ox1(ctx, ox, oy, gx + 8, sy, 4, 3, ink);
        fx(ctx, ox, oy, gx + 4, sy + 1, 1, 1, ink); // connector
        fx(ctx, ox, oy, gx + 5, sy, 1, 3, ink); // arrowhead, 3 px tall
        fx(ctx, ox, oy, gx + 6, sy, 1, 2, ink); // 2 px tall
        fx(ctx, ox, oy, gx + 7, sy + 1, 1, 1, ink); // tip, pointing into box B
      }
      if (squiggleFits) {
        // Hand-written wave: 2-3 px runs stepping up and down across three rows.
        const qy = squiggleTop;
        const runs: Array<[number, number, number]> = [
          [0, 0, 2],
          [1, 2, 3],
          [2, 3, 5],
          [1, 5, 6],
          [0, 6, 8],
          [1, 8, 9],
          [2, 9, 10],
        ];
        runs.forEach(([ry, rx0, rx1]) => {
          fx(ctx, ox, oy, gx + rx0, qy + ry, rx1 - rx0 + 1, 1, ACCENT.violet);
        });
      }

      // Marker tray: aluminium strip across the bottom edge. Light top row, base bottom row, and
      // outline only on the outer ends. Three 2 px markers and an eraser sit on the top row.
      fx(ctx, ox, oy, 1, H - 4, W - 2, 1, PALETTE.steel.light);
      fx(ctx, ox, oy, 1, H - 3, W - 2, 1, PALETTE.steel.base);
      fx(ctx, ox, oy, 1, H - 4, 1, 2, OUTLINE);
      fx(ctx, ox, oy, W - 2, H - 4, 1, 2, OUTLINE);
      fx(ctx, ox, oy, 2, H - 4, 2, 1, ACCENT.red);
      fx(ctx, ox, oy, 5, H - 4, 2, 1, ACCENT.blue);
      fx(ctx, ox, oy, 8, H - 4, 2, 1, ACCENT.green);
      fx(ctx, ox, oy, W - 5, H - 4, 3, 1, ACCENT.cream);
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
      // Panelled door in a steel frame: recessed panels shadowed top-left and lit bottom-right,
      // with a brass knob.
      drawMask(
        ctx,
        ox,
        oy,
        [
          'oooooooooooooooo',
          'oFFFFFFFFFFFFFfo',
          'oFfoooooooooofgo',
          'oFfoWWWWWWWWofgo',
          'oFfoWvvvvvvwofgo',
          'oFfoWvwwwwhwofgo',
          'oFfoWvwwwwhwofgo',
          'oFfoWwhhhhhwofgo',
          'oFfoWwwwwwKkofgo',
          'oFfoWvvvvvvwofgo',
          'oFfoWvwwwwhwofgo',
          'oFfoWvwwwwhwofgo',
          'oFfoWwhhhhhwofgo',
          'oFfoWwwwwwwwofgo',
          'oFfovvvvvvvvofgo',
          'oggggggggggggggo',
        ],
        {
          o: OUTLINE,
          F: PALETTE.steel.light,
          f: PALETTE.steel.base,
          g: PALETTE.steel.dark,
          W: PALETTE.darkwood.light,
          w: PALETTE.darkwood.base,
          v: PALETTE.darkwood.dark,
          h: PALETTE.darkwood.hi,
          K: PALETTE.amber.light,
          k: PALETTE.amber.dark,
        },
        Math.floor((W - 16) / 2),
        H - 16
      );
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
interface DisplayPos {
  x: number;
  y: number;
  isMoving: boolean;
  /** Displayed kart heading (radians), present only while the user is in a kart. */
  heading?: number;
  /** Whether the kart is boosting (draws the exhaust flame). */
  boost?: boolean;
  /** Car model of the kart; undefined draws the default car. */
  model?: KartModel;
}
const displayPosMap = new Map<string, DisplayPos>();
let animFrameId: number | null = null;

// Tyre marks left by karts that are sliding. Each entry is a tile-space point and when it was laid.
const SKID_MAX = 200;
const SKID_LIFE_MS = 2000;
const skidMarks: { x: number; y: number; born: number }[] = [];

function addSkidMarks(x: number, y: number, heading: number, now: number) {
  // Rear wheels: 0.28 tiles behind the kart centre, 0.3 tiles either side of the axis.
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  for (const side of [-1, 1]) {
    skidMarks.push({
      x: x + 0.5 - fx * 0.28 - fy * 0.3 * side,
      y: y + 0.5 - fy * 0.28 + fx * 0.3 * side,
      born: now,
    });
  }
  while (skidMarks.length > SKID_MAX) skidMarks.shift();
}

function renderSkidMarks(ctx: CanvasRenderingContext2D, now: number) {
  while (skidMarks.length > 0 && now - skidMarks[0].born > SKID_LIFE_MS) skidMarks.shift();
  if (skidMarks.length === 0) return;
  ctx.save();
  // Each mark is one art pixel snapped to the grid. A round stamp would anti-alias into a grey
  // smear at this size, while a single dark pixel reads as tyre grit on the asphalt.
  for (const m of skidMarks) {
    ctx.globalAlpha = 0.35 * (1 - (now - m.born) / SKID_LIFE_MS);
    fx(ctx, 0, 0, Math.floor(m.x * ART), Math.floor(m.y * ART), 1, 1, '#0e1117');
  }
  ctx.restore();
}

// ============================================================================
// Character avatars
// ============================================================================
// The sprite itself lives in lib/avatarSprite.ts so the world canvas and the Avatar Studio
// preview draw the exact same character. What stays here is only the world-specific chrome
// around it: proximity rings, the walk cycle driven by interpolated movement, and the name
// tag - none of which belong in a preview.

/** Art-pixel scale of a kart driver's head. The full sprite uses PX; the head is drawn smaller to fit the seat. */
const KART_HEAD_SCALE = 2;
/** Seat position along the kart's heading, as a fraction of a cell (negative = behind centre). 0 puts the head over the drawn cockpit, which is centred on every model. */
const KART_SEAT_OFFSET = 0;

function renderUser(
  ctx: CanvasRenderingContext2D,
  user: User,
  isSelf: boolean,
  displayPos: DisplayPos,
  isGhost = false
) {
  const px = displayPos.x * CELL_SIZE + CELL_SIZE / 2;
  const py = displayPos.y * CELL_SIZE + CELL_SIZE / 2;
  // Driving: the kart is drawn under the driver's head, which sits in the seat and faces the way it turns.
  const kartHeading = displayPos.heading;

  // The walking bounce lives in the sprite now, locked to the step it belongs to. It used
  // to be a sine applied to py here, which moved the body by fractional pixels - and since
  // the sprite origin has to be rounded to stay crisp, that surfaced as an irregular 1-2px
  // jitter rather than a bounce.

  ctx.save();

  // Ghost Mode: your own avatar turns translucent while phasing through others
  if (isSelf && isGhost) {
    ctx.globalAlpha = 0.45;
  }

  // Proximity Voice Halo Ring (If speaking)
  if (user.isSpeaking) {
    // Centred on the body, so the ring encloses the head and the torso.
    const haloY =
      kartHeading !== undefined ? py - 8 : py + 13 - (AV_GROUND_Y - AV_BODY_CENTER_Y) * PX;
    ctx.strokeStyle = ACCENT.green;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(px, haloY, 36, 0, Math.PI * 2);
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
  if (kartHeading !== undefined) {
    if (displayPos.boost) {
      drawKartBoost(ctx, px, py, kartHeading, CELL_SIZE, Date.now(), displayPos.model);
    }
    drawKart(
      ctx,
      px,
      py,
      kartHeading,
      kartBodyColor(user.id, user.avatar?.outfitColor),
      CELL_SIZE,
      displayPos.model,
    );
  }

  const direction = kartHeading !== undefined ? directionFromHeading(kartHeading) : user.direction;
  // Y the name tag sits above (its bottom edge is this minus the gap).
  let tagAnchorY: number;
  if (kartHeading !== undefined) {
    // Driving: only the head shows, sat in the seat just behind the kart's centre. Presence pip
    // and status chip are not drawn while driving.
    const seatX = px + Math.cos(kartHeading) * KART_SEAT_OFFSET * CELL_SIZE;
    const seatY = py + Math.sin(kartHeading) * KART_SEAT_OFFSET * CELL_SIZE;
    drawAvatarHead(ctx, seatX, seatY, KART_HEAD_SCALE, user.avatar, { direction });
    tagAnchorY = py - CELL_SIZE / 2 - 4;
  } else {
    // The ground line sits where it always did (py + 13); the sprite box extends above it.
    const oxp = Math.round(px - (AV_W / 2) * PX);
    const oyp = Math.round(py + 13 - AV_GROUND_Y * PX);

    drawAvatarSprite(ctx, oxp, oyp, PX, user.avatar, {
      direction,
      walkPhase: displayPos.isMoving ? Math.floor(Date.now() / 120) % 4 : -1,
      presence: user.presenceStatus,
      showEmoji: true,
    });
    tagAnchorY = oyp + AV_HEAD_TOP_Y * PX - 6;
  }

  // --- Name tag ---------------------------------------------------------------
  const nameText = isSelf ? `${user.name} (YOU)` : user.name;
  ctx.font = 'bold 12px "Pixelify Sans", cursive, sans-serif';
  const textWidth = ctx.measureText(nameText).width;

  const tagW = textWidth + 14;
  const tagH = 20;
  const tagX = Math.round(px - tagW / 2);
  const tagY = tagAnchorY - tagH;

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

// Art pixels are drawn as many adjacent fillRect calls. At a fractional device scale (e.g. a 0.75
// zoom) their edges land between device pixels, and the browser antialiases each rect, which leaves
// faint seams between neighbours. Rounding both edges of every rect to whole device pixels makes
// neighbours share an edge exactly. Only the main map context is patched; offscreen caches are
// drawn at integer base px already.
const pixelSnapScale = new WeakMap<CanvasRenderingContext2D, { sx: number; sy: number }>();

function installPixelSnap(ctx: CanvasRenderingContext2D, sx: number, sy: number) {
  const existing = pixelSnapScale.get(ctx);
  if (existing) {
    existing.sx = sx;
    existing.sy = sy;
    return;
  }
  const scale = { sx, sy };
  pixelSnapScale.set(ctx, scale);
  const rawFillRect = CanvasRenderingContext2D.prototype.fillRect;
  ctx.fillRect = (x: number, y: number, w: number, h: number) => {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (w === 0 || h === 0) return;
    const x0 = Math.round(x * scale.sx);
    const y0 = Math.round(y * scale.sy);
    let x1 = Math.round((x + w) * scale.sx);
    let y1 = Math.round((y + h) * scale.sy);
    // Keep 1-device-px details visible even when both edges round to the same pixel.
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    rawFillRect.call(ctx, x0, y0, x1 - x0, y1 - y0);
    ctx.setTransform(scale.sx, 0, 0, scale.sy, 0, 0);
  };
}

// Main Render Loop. `frameDt` is the seconds since the previous animation frame; it is zero for
// renders triggered by a prop change, which must not advance the per-frame motion (headings,
// skid detection) a second time.
function renderCanvas(frameDt = 0) {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const map = props.currentMap;
  const baseW = map.width * CELL_SIZE;
  const baseH = map.height * CELL_SIZE;
  // The backing store is sized to the on-screen device pixels, so text and sprites are drawn at
  // the resolution they are shown at instead of being resampled by the browser. Capped so a large
  // zoom or devicePixelRatio cannot exceed the canvas limits (8192 px per side, ~16.7M pixels).
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(
    zoom.value * dpr,
    8192 / baseW,
    8192 / baseH,
    Math.sqrt(16_777_216 / (baseW * baseH)),
  );
  const bufW = Math.round(baseW * scale);
  const bufH = Math.round(baseH * scale);
  // Assigning width/height resets the whole 2D context - including the transform and
  // imageSmoothingEnabled - so only resize when the size actually changed, and set the state
  // afterwards. Smoothing has to stay off or the terrain blit below would come out blurred.
  if (canvas.width !== bufW || canvas.height !== bufH) {
    canvas.width = bufW;
    canvas.height = bufH;
  }
  // Display size follows zoom; the backing store above is in device pixels.
  applyCanvasSize();

  // Clear in device pixels, then map base px onto the backing store. The ratios are taken from the
  // rounded buffer size, so the bitmap matches the CSS box exactly.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / baseW, 0, 0, canvas.height / baseH, 0, 0);
  installPixelSnap(ctx, canvas.width / baseW, canvas.height / baseH);
  ctx.imageSmoothingEnabled = false;

  // 1. Draw Tiles (cached; only the animated water highlights are per-frame work)
  ctx.drawImage(getTerrain(map), 0, 0);
  waterCells.forEach(({ x, y }) => renderWaterAnimation(ctx, x, y));
  renderSkidMarks(ctx, performance.now());

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
      ctx.font = 'bold 11px "Silkscreen", cursive';
      const zoneLabel = `🔒 ${zone.name}`;
      const textWidth = ctx.measureText(zoneLabel).width;
      const boxWidth = Math.max(textWidth + 16, 60);
      const boxHeight = 22;

      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(zx + 8, zy + 8, boxWidth, boxHeight);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.strokeRect(zx + 8, zy + 8, boxWidth, boxHeight);

      ctx.fillStyle = '#0f172a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(zoneLabel, zx + 8 + boxWidth / 2, zy + 8 + boxHeight / 2 + 1);
    }
  });

  // 3. Draw Objects
  map.objects.forEach((obj) => {
    if (isDraggingObject.value && draggedObject.value && obj.id === draggedObject.value.id) {
      // Draw ghost at original position
      ctx.save();
      ctx.globalAlpha = 0.35;
      renderObject(ctx, obj);
      ctx.restore();

      // Draw dashed outline at original position
      const ox = obj.x * CELL_SIZE;
      const oy = obj.y * CELL_SIZE;
      const ow = obj.width * CELL_SIZE;
      const oh = obj.height * CELL_SIZE;
      ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(ox + 1, oy + 1, ow - 2, oh - 2);
      ctx.setLineDash([]);
    } else {
      renderObject(ctx, obj);

      // If hovered in builder mode (and not dragging another object), draw hover outline
      if (
        props.builderMode &&
        hoveredObject.value &&
        hoveredObject.value.id === obj.id &&
        !isDraggingObject.value
      ) {
        const ox = obj.x * CELL_SIZE;
        const oy = obj.y * CELL_SIZE;
        const ow = obj.width * CELL_SIZE;
        const oh = obj.height * CELL_SIZE;

        ctx.save();
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 3;
        ctx.shadowColor = "rgba(56, 189, 248, 0.8)";
        ctx.shadowBlur = 8;
        ctx.strokeRect(ox, oy, ow, oh);

        ctx.fillStyle = "#38bdf8";
        ctx.fillRect(ox - 3, oy - 3, 6, 6);
        ctx.fillRect(ox + ow - 3, oy - 3, 6, 6);
        ctx.fillRect(ox - 3, oy + oh - 3, 6, 6);
        ctx.fillRect(ox + ow - 3, oy + oh - 3, 6, 6);
        ctx.restore();
      }
    }
  });

  // 3.5 Draw Active Dragged Object & Snap Box Overlay
  if (isDraggingObject.value && draggedObject.value && currentDragTile.value) {
    const dragX = currentDragTile.value.x;
    const dragY = currentDragTile.value.y;
    const dragW = draggedObject.value.width;
    const dragH = draggedObject.value.height;

    const pxX = dragX * CELL_SIZE;
    const pxY = dragY * CELL_SIZE;
    const pxW = dragW * CELL_SIZE;
    const pxH = dragH * CELL_SIZE;

    // Draw active object preview at drag target
    ctx.save();
    ctx.globalAlpha = 0.9;
    const tempObj: MapObject = {
      ...draggedObject.value,
      x: dragX,
      y: dragY,
    };
    renderObject(ctx, tempObj);
    ctx.restore();

    // Draw snap grid box & drag indicator glow
    ctx.save();
    ctx.fillStyle = "rgba(251, 191, 36, 0.15)";
    ctx.fillRect(pxX, pxY, pxW, pxH);

    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#f59e0b";
    ctx.shadowBlur = 10;
    ctx.strokeRect(pxX + 1, pxY + 1, pxW - 2, pxH - 2);

    // Draw coordinates badge tag
    const badgeText = `Move: (${dragX}, ${dragY})`;
    ctx.font = 'bold 11px "Pixelify Sans", cursive, sans-serif';
    const textWidth = ctx.measureText(badgeText).width;
    const badgeW = textWidth + 12;
    const badgeH = 18;
    const badgeX = pxX + pxW / 2 - badgeW / 2;
    const badgeY = Math.max(4, pxY - 22);

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

    ctx.fillStyle = "#fef08a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeText, pxX + pxW / 2, badgeY + badgeH / 2 + 1);
    ctx.restore();
  }

  // 4. Draw Users with lerp position interpolation and walking animation
  const advancing = frameDt > 0;
  // Positions are updated for everyone first, then the characters are drawn sorted by their
  // displayed y, so a character further down the screen draws over one further up.
  const drawQueue: Array<{ user: User; isSelfUser: boolean; pos: DisplayPos }> = [];
  props.users.forEach((user) => {
    const isSelfUser = user.socketId === props.currentUser.socketId;
    // Our own kart is simulated locally, so draw exactly where the simulation is. The users list
    // lags one server round trip behind it.
    const selfDriving = isSelfUser && Boolean(props.currentUser.kart);
    const source = selfDriving ? (props.localKart ?? props.currentUser.position) : user.position;

    let currentPos = displayPosMap.get(user.socketId);
    const targetX = source?.x ?? 0;
    const targetY = source?.y ?? 0;
    const prevX = currentPos?.x ?? targetX;
    const prevY = currentPos?.y ?? targetY;

    if (!currentPos) {
      currentPos = { x: targetX, y: targetY, isMoving: false };
      displayPosMap.set(user.socketId, currentPos);
    } else if (selfDriving) {
      currentPos.x = targetX;
      currentPos.y = targetY;
      currentPos.isMoving = false;
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

    // Kart heading: ours is exact; everyone else's eases toward the last reported heading.
    const kart = isSelfUser ? props.currentUser.kart : user.kart;
    const targetHeading = kart
      ? isSelfUser && props.localKart
        ? props.localKart.heading
        : kart.heading
      : undefined;
    if (targetHeading === undefined) {
      currentPos.heading = undefined;
    } else if (currentPos.heading === undefined || isSelfUser) {
      currentPos.heading = targetHeading;
    } else if (advancing) {
      currentPos.heading = lerpAngle(currentPos.heading, targetHeading, 0.3);
    }
    // Boost is not eased: the flame should start and stop with the boost itself.
    currentPos.boost =
      targetHeading !== undefined &&
      Boolean(isSelfUser ? props.localKart?.boost : kart?.boost);
    // Our own kart's model comes from currentUser (set on pick), everyone else's from the users list.
    currentPos.model = kart?.model;

    // Tyre marks: ours from the simulation, anyone else's from their displayed motion against
    // their displayed heading.
    if (advancing && currentPos.heading !== undefined) {
      let sliding = false;
      if (isSelfUser) {
        sliding = Boolean(props.localKart?.sliding);
      } else {
        const vx = (currentPos.x - prevX) / frameDt;
        const vy = (currentPos.y - prevY) / frameDt;
        // Above 30 tiles/s is a server jump, not a skid.
        const speed = Math.hypot(vx, vy);
        const moving = speed > 3 && speed < 30;
        const slip = Math.abs(normalizeAngle(Math.atan2(vy, vx) - currentPos.heading));
        sliding = moving && slip > 0.3;
      }
      if (sliding) addSkidMarks(currentPos.x, currentPos.y, currentPos.heading, performance.now());
    }

    drawQueue.push({ user, isSelfUser, pos: currentPos });
  });
  drawQueue
    .sort((a, b) => a.pos.y - b.pos.y)
    .forEach(({ user, isSelfUser, pos }) =>
      renderUser(ctx, user, isSelfUser, pos, isSelfUser && isGhostMode.value)
    );

  // 4.5 Portal names. Shown when you are close to one (or while building, when every target
  //     matters), so the floor is not covered in labels.
  (map.objects || []).forEach((obj) => {
    if (obj.type !== 'portal') return;
    // Live position: while driving, the per-frame kart simulation rather than the sent one.
    const me = props.localKart ?? props.currentUser.position;
    const px = obj.x + (obj.width || 1) / 2;
    const py = obj.y + (obj.height || 1) / 2;
    const near = me && Math.hypot(me.x + 0.5 - px, me.y + 0.5 - py) <= 3;
    if (near || props.builderMode) renderPortalLabel(ctx, obj);
  });

  // 5. Zone being dragged out in the builder. Drawn last, on top of everything, so the
  //    rectangle stays readable over furniture and avatars while it is being sized.
  const zoneRect = pendingZoneRect.value;
  if (zoneRect) {
    const zx = zoneRect.x * CELL_SIZE;
    const zy = zoneRect.y * CELL_SIZE;
    const zw = zoneRect.width * CELL_SIZE;
    const zh = zoneRect.height * CELL_SIZE;

    ctx.fillStyle = 'rgba(125, 138, 224, 0.28)';
    ctx.fillRect(zx, zy, zw, zh);
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(zx + 1.5, zy + 1.5, zw - 3, zh - 3);
    ctx.setLineDash([]);

    // Live size readout - the whole point of drawing the zone is not having to work the
    // numbers out, so show them as they change.
    const caption = `${zoneRect.width} x ${zoneRect.height}`;
    ctx.font = 'bold 12px "Pixelify Sans", cursive, sans-serif';
    const captionW = ctx.measureText(caption).width + 14;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(zx + zw / 2 - captionW / 2, zy + zh / 2 - 11, captionW, 22);
    ctx.fillStyle = '#f4efe3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, zx + zw / 2, zy + zh / 2 + 1);
  }

  followCamera();
}

let lastFrameMs: number | null = null;
function startAnimLoop() {
  const nowMs = performance.now();
  // Clamped so a backgrounded tab does not make the first frame back fly across the map.
  const frameDt = lastFrameMs === null ? 0 : Math.min(0.1, (nowMs - lastFrameMs) / 1000);
  lastFrameMs = nowMs;
  renderCanvas(frameDt);
  animFrameId = requestAnimationFrame(startAnimLoop);
}

let lastKeyMoveTime = 0;
const KEY_MOVE_COOLDOWN_MS = 140;

// Shared movement step, used by both keyboard input and the on-screen mobile D-pad
function movePlayer(dx: number, dy: number, dir: 'up' | 'down' | 'left' | 'right') {
  // Driving is handled by useKartDriving; grid steps would fight the kart simulation.
  if (props.currentUser.kart) return;
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

  // Driving: useKartDriving reads the arrow and WASD keys itself.
  if (props.currentUser.kart) return;

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

// Pointer Drag & Hover Event Handlers for Object Movement
function handlePointerDown(e: PointerEvent) {
  if (!props.builderMode || !props.currentMap) return;

  const canvas = canvasRef.value;
  if (!canvas) return;

  const { x: tileX, y: tileY } = clientToTile(e);

  // Drawing a zone owns the whole gesture - it must not also pick up and drag whatever
  // object happens to sit under the first corner.
  if (props.zoneDrawMode) {
    zoneDragStart.value = { x: tileX, y: tileY };
    zoneDragEnd.value = { x: tileX, y: tileY };
    isMouseDown.value = true;
    hasDragged.value = true; // suppress the click that follows this drag
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
    return;
  }

  const existingObj = props.currentMap.objects.find(
    (o) => tileX >= o.x && tileX < o.x + o.width && tileY >= o.y && tileY < o.y + o.height
  );

  isMouseDown.value = true;
  mouseDownPos.value = { x: e.clientX, y: e.clientY };
  hasDragged.value = false;

  if (existingObj) {
    draggedObject.value = existingObj;
    dragOffsetGrid.value = { x: tileX - existingObj.x, y: tileY - existingObj.y };
    currentDragTile.value = { x: existingObj.x, y: existingObj.y };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
  } else {
    draggedObject.value = null;
    currentDragTile.value = null;
  }
}

function handlePointerMove(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;

  const { x: tileX, y: tileY } = clientToTile(e);

  if (props.zoneDrawMode) {
    if (zoneDragStart.value) zoneDragEnd.value = { x: tileX, y: tileY };
    return;
  }

  if (props.builderMode) {
    const objUnderMouse = props.currentMap.objects.find(
      (o) => tileX >= o.x && tileX < o.x + o.width && tileY >= o.y && tileY < o.y + o.height
    );
    hoveredObject.value = objUnderMouse || null;

    if (isMouseDown.value && draggedObject.value && mouseDownPos.value) {
      const dist = Math.hypot(e.clientX - mouseDownPos.value.x, e.clientY - mouseDownPos.value.y);
      if (dist > 4) {
        isDraggingObject.value = true;
        hasDragged.value = true;
      }

      if (isDraggingObject.value) {
        let targetX = tileX - dragOffsetGrid.value.x;
        let targetY = tileY - dragOffsetGrid.value.y;

        targetX = Math.max(0, Math.min(props.currentMap.width - draggedObject.value.width, targetX));
        targetY = Math.max(0, Math.min(props.currentMap.height - draggedObject.value.height, targetY));

        currentDragTile.value = { x: targetX, y: targetY };
      }
    }
  } else {
    hoveredObject.value = null;
  }
}

function handlePointerUp(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (canvas && e.pointerId !== undefined) {
    try {
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}
  }

  // Releasing after dragging out a zone is what commits it.
  if (props.zoneDrawMode && zoneDragStart.value) {
    const rectangle = pendingZoneRect.value;
    zoneDragStart.value = null;
    zoneDragEnd.value = null;
    isMouseDown.value = false;
    if (rectangle) emit("zoneDrawn", rectangle);
    return;
  }

  if (isDraggingObject.value && draggedObject.value && currentDragTile.value) {
    if (
      currentDragTile.value.x !== draggedObject.value.x ||
      currentDragTile.value.y !== draggedObject.value.y
    ) {
      emit("moveObject", {
        objectId: draggedObject.value.id,
        x: currentDragTile.value.x,
        y: currentDragTile.value.y,
      });
    }
  }

  isMouseDown.value = false;
  isDraggingObject.value = false;
  draggedObject.value = null;
  currentDragTile.value = null;
}

/**
 * An interrupted gesture must not commit anything. pointercancel fires when the browser
 * takes the pointer away mid-drag (a system gesture, the pointer being invalidated, and so
 * on); treating it as a normal pointerup turned that into a stray 1x1 zone and dropped the
 * user out of draw mode.
 */
function handlePointerCancel(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (canvas && e.pointerId !== undefined) {
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }
  zoneDragStart.value = null;
  zoneDragEnd.value = null;
  isMouseDown.value = false;
  isDraggingObject.value = false;
  draggedObject.value = null;
  currentDragTile.value = null;
}

function handlePointerLeave(e: PointerEvent) {
  if (!isDraggingObject.value) {
    hoveredObject.value = null;
  }
}

function handleGlobalPointerUp(e: PointerEvent) {
  if (isMouseDown.value || isDraggingObject.value) {
    handlePointerUp(e);
  }
}

// Canvas Click Event Handler
/**
 * Right-clicking someone opens their context menu. The hit test is against the *rendered*
 * position (displayPosMap), not the authoritative tile, so it matches what the user is
 * actually pointing at while people are mid-step.
 */
function handleContextMenu(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas || props.builderMode) return;

  // Hit test in base map px (the space sprites are drawn in), so it holds at any zoom. The base
  // size is used rather than canvas.width, which is in device pixels.
  const rect = canvas.getBoundingClientRect();
  const x = mapPxFromClient(e.clientX, rect.left, rect.width, props.currentMap.width * CELL_SIZE);
  const y = mapPxFromClient(e.clientY, rect.top, rect.height, props.currentMap.height * CELL_SIZE);

  const hit = props.users.find((u) => {
    if (u.socketId === props.currentUser.socketId) return false;
    const pos = displayPosMap.get(u.socketId) ?? u.position;
    const cx = (pos.x + 0.5) * CELL_SIZE;
    const cy = (pos.y + 0.5) * CELL_SIZE;
    // The sprite is about one tile wide and stands a little above its tile centre.
    return Math.abs(x - cx) <= CELL_SIZE / 2 && y >= cy - CELL_SIZE && y <= cy + CELL_SIZE / 2;
  });
  if (!hit) return;

  e.preventDefault();
  emit("userContextMenu", { socketId: hit.socketId, clientX: e.clientX, clientY: e.clientY });
}

function handleCanvasClick(e: MouseEvent) {
  if (hasDragged.value) {
    hasDragged.value = false;
    return;
  }

  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;

  const { x: tileX, y: tileY } = clientToTile(e);

  if (props.zoneDrawMode) return;

  if (props.builderMode) {
    if (props.builderAction === "erase") {
      const existingObj = props.currentMap.objects.find(
        (o) => tileX >= o.x && tileX < o.x + o.width && tileY >= o.y && tileY < o.y + o.height
      );
      if (existingObj) {
        emit("removeObject", existingObj.id);
      }
    } else if (props.builderAction === "move") {
      return;
    } else {
      if (props.selectedObject) {
        const isDesk = props.selectedObject.type === "desk";
        const newObj: MapObject = {
          ...props.selectedObject,
          id: `obj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          x: tileX,
          y: tileY,
          data: isDesk
            ? {
                deskState: {
                  deskLabel: "Workstation Desk",
                  equipment: "laptop",
                  stickyNotes: [],
                  ...(props.selectedObject.data?.deskState || {}),
                },
                ...(props.selectedObject.data || {}),
              }
            : props.selectedObject.data,
        };
        emit("placeObject", newObj);
      } else if (props.selectedTile) {
        emit("changeTile", { x: tileX, y: tileY, tileType: props.selectedTile });
      }
    }
  } else {
    const clickedObj = props.currentMap.objects.find(
      (o) => tileX >= o.x && tileX < o.x + o.width && tileY >= o.y && tileY < o.y + o.height
    );

    if (clickedObj?.type === "portal") {
      // Walk onto the portal; the server takes you through it on arrival.
      emit("navigateTile", { x: clickedObj.x, y: clickedObj.y });
    } else if (clickedObj) {
      emit("interactObject", clickedObj);
    } else {
      emit("navigateTile", { x: tileX, y: tileY });
    }
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", endGhostMode);
  window.addEventListener("pointerup", handleGlobalPointerUp);
  updateIsMobile();
  window.addEventListener("resize", updateIsMobile);
  // Not passive: the wheel zooms the map, so the page must not scroll underneath it.
  scrollContainerRef.value?.addEventListener("wheel", handleWheel, { passive: false });
  startAnimLoop();
});

onUnmounted(() => {
  scrollContainerRef.value?.removeEventListener("wheel", handleWheel);
  window.removeEventListener("keydown", handleKeyDown);
  window.removeEventListener("keyup", handleKeyUp);
  window.removeEventListener("blur", endGhostMode);
  window.removeEventListener("pointerup", handleGlobalPointerUp);
  window.removeEventListener("resize", updateIsMobile);
  stopDpadMove();
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
  }
});

// Another map (a portal, or an admin switching presets): forget everything that was about the
// old one. Avatars snap to their new positions rather than gliding over from the old map's
// coordinates, and any drag or hover still pointing at an object from the old map is dropped.
watch(() => props.currentMap.id, () => {
  displayPosMap.clear();
  skidMarks.length = 0;
  hoveredObject.value = null;
  isDraggingObject.value = false;
  draggedObject.value = null;
  currentDragTile.value = null;
  zoneDragStart.value = null;
  zoneDragEnd.value = null;
});

watch([() => props.currentUser, () => props.users, () => props.currentMap, () => props.builderMode], () => {
  renderCanvas();
}, { deep: true });
</script>

<template>
  <!-- Centring is done with auto margins on the content, not flex justify-center: flex centring
       pushes an overflowing map past the left edge, where scrolling cannot reach it. -->
  <div
    ref="scrollContainerRef"
    class="w-full h-full overflow-auto custom-scrollbar p-4"
  >
    <div ref="contentRef" class="w-max mx-auto">
      <div class="block relative border-4 border-slate-900 shadow-[8px_8px_0px_0px_#020617] bg-slate-900 overflow-hidden rounded-2xl pixel-rendering">
        <canvas
          ref="canvasRef"
          @click="handleCanvasClick"
          @contextmenu="handleContextMenu"
          @pointerdown="handlePointerDown"
          @pointermove="handlePointerMove"
          @pointerup="handlePointerUp"
          @pointerleave="handlePointerLeave"
          @pointercancel="handlePointerCancel"
          :style="{ cursor: canvasCursor }"
          class="block touch-none pixel-rendering"
        />
      </div>
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
