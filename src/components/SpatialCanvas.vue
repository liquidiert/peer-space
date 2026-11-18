<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
import type { User, GridMap, MapObject, TileType } from "../types";
import type { KartModel } from "../lib/kartModels";
import { ACCENT, mixHex, type Ramp } from "../lib/pixelArt";
import { AV_H, AV_INK as AVATAR_INK, AV_W, drawAvatarHead, drawAvatarSprite } from "../lib/avatarSprite";
import { directionFromHeading, lerpAngle, normalizeAngle } from "../lib/kart";
import { drawKart, drawKartBoost, kartBodyColor } from "../lib/kartSprite";
import {
  ZOOM_DEFAULT,
  ZOOM_STORAGE_KEY,
  anchoredScroll,
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

// Map zoom (desktop mouse wheel). The canvas keeps its internal resolution; only its CSS size
// scales, so every pointer conversion has to go through the laid-out rect (see clientToTile).
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

// Mobile camera-follow: on small/touch screens the map is larger than the
// viewport, so we auto-scroll the container to keep the player's avatar centered.
const isMobile = ref(false);
function updateIsMobile() {
  isMobile.value = window.matchMedia('(max-width: 768px)').matches;
}

/** How much map to keep visible ahead of the avatar before the desktop camera nudges. */
const EDGE_MARGIN = CELL_SIZE * 3;

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

  if (driving || isMobile.value) {
    // Hard-centre on both axes. Driving needs it on desktop too: the kart has to stay in view
    // while the player steers. Phones show only a handful of tiles, so they always centre.
    const left = clampScroll(centreScroll(targetX, viewW, origin.left, zoomNow), maxLeft);
    const top = clampScroll(centreScroll(targetY, viewH, origin.top, zoomNow), maxTop);
    if (Math.round(left) !== Math.round(container.scrollLeft) || Math.round(top) !== Math.round(container.scrollTop)) {
      container.scrollTo({ left, top, behavior: 'auto' });
    }
    return;
  }

  // Desktop walking follows horizontally only: the map is wider than most windows but generally
  // fits vertically. It is a dead-zone follow rather than a re-centre - this runs every animation
  // frame, so hard-centring would make the map impossible to scroll by hand.
  const avatarX = origin.left + targetX * zoomNow;
  const viewLeft = container.scrollLeft;
  const viewRight = viewLeft + viewW;

  let targetLeft = viewLeft;
  if (avatarX < viewLeft + EDGE_MARGIN) {
    targetLeft = avatarX - EDGE_MARGIN;
  } else if (avatarX > viewRight - EDGE_MARGIN) {
    targetLeft = avatarX - viewW + EDGE_MARGIN;
  }
  targetLeft = clampScroll(targetLeft, maxLeft);
  // Omitting `top` leaves the vertical scroll exactly where the user put it.
  if (Math.round(targetLeft) !== Math.round(viewLeft)) {
    container.scrollTo({ left: targetLeft, behavior: 'auto' });
  }
}

/** Set the map's zoom and resize the canvas's CSS box right away, so the caller can read the new layout. */
function setZoom(next: number) {
  zoom.value = clampZoom(next);
  storeZoom(zoom.value);
  applyCanvasSize();
}

/** CSS size of the canvas = internal size * zoom. Only writes when the value changes. */
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
 * Mouse wheel zooms the map on desktop. Walking keeps the map point under the cursor fixed;
 * driving keeps the kart centred instead (followCamera does that).
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

  const cRect = container.getBoundingClientRect();
  const anchorX = e.clientX - cRect.left - container.clientLeft;
  const anchorY = e.clientY - cRect.top - container.clientTop;
  const oldLeft = container.scrollLeft;
  const oldTop = container.scrollTop;
  const before = canvasOriginInScroll(container, canvas);

  // Synchronous: the new CSS size and the new scroll are applied before the next paint, so the
  // zoom does not flash the old scroll position.
  setZoom(newZoom);
  const after = canvasOriginInScroll(container, canvas);

  if (props.currentUser.kart) {
    followCamera();
    return;
  }
  container.scrollTo({
    left: anchoredScroll(oldLeft, anchorX, oldZoom, newZoom, before.left, after.left),
    top: anchoredScroll(oldTop, anchorY, oldZoom, newZoom, before.top, after.top),
    behavior: 'auto',
  });
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
      floorTransitions(ctx, ox, oy, x, y, tiles);
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
      floorTransitions(ctx, ox, oy, x, y, tiles);
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

      // Depth bands with dithered seams between them. The bands are read through a wobble so the
      // contours are organic; shadow and foam below use the raw distance so the shoreline stays crisp.
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
          const checker = (wx + wy) % 2 === 0;
          const n = waterNoise(wx, wy);
          const de = d + n;
          let c: string;
          if (de < 3) c = p.light;
          else if (de < 6) c = checker ? p.light : p.base;
          else if (de < 12) c = p.base;
          else if (de < 14) c = checker ? p.base : p.dark;
          else c = p.dark;
          fx(ctx, ox, oy, i, j, 1, 1, c);

          // Land above or left casts a 2px shadow onto the water, then the foam sits one pixel
          // beyond it. Without a cast shadow the foam sits one pixel out from the bank directly.
          const castD = cast[k];
          if (castD < 2) fxa(ctx, ox, oy, i, j, 1, 1, p.shadow, 0.45);
          const start = castD <= d + 0.01 ? 2 : 1;
          if (d >= start && d < start + 1) {
            fxa(ctx, ox, oy, i, j, 1, 1, p.hi, 0.7);
          } else if (d >= start + 1 && d < start + 2) {
            // Broken foam: thin, dithered and patchy so the line looks like wash, not a border.
            if (checker && tileHash(wx, wy, 83) > 0.35) fxa(ctx, ox, oy, i, j, 1, 1, p.hi, 0.45);
          } else if (d >= start + 2 && d < start + 3) {
            if ((wx + wy) % 4 === 0 && tileHash(wx, wy, 84) > 0.6) fxa(ctx, ox, oy, i, j, 1, 1, p.hi, 0.3);
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

    case "conference_table": {
      const tableP = PALETTE.darkwood;
      const steelP = PALETTE.steel;
      const chairP = PALETTE.indigo;

      // The old art was a plain rectangle with a row of stubby blocks above and below it,
      // which read as a bench rather than a meeting table and never made it obvious how
      // many people it seats. It is now drawn as a real boardroom table: seats on all four
      // sides (each an actual chair with a backrest, arms and a shadow), a chamfered top
      // with a lighter inlay, a cable tray with grommets down the middle, and a few props.
      const seatsPerSide = Math.max(2, Math.round(W / 16));
      const CHAIR_W = 8;
      const CHAIR_D = 5; // depth: backrest + seat

      /**
       * One chair, in art pixels, facing the table. `side` decides which way the backrest
       * sits relative to the seat, so the same routine serves all four edges.
       */
      function drawChair(cx: number, cy: number, side: 'top' | 'bottom' | 'left' | 'right') {
        const horizontal = side === 'top' || side === 'bottom';
        const w = horizontal ? CHAIR_W : CHAIR_D;
        const h = horizontal ? CHAIR_D : CHAIR_W;

        // Contact shadow first so the chair sits on the floor rather than floating.
        fx(ctx, ox, oy, cx + 1, cy + h - 1, w - 1, 1, 'rgba(20, 26, 44, 0.28)');

        // Seat pad.
        shadedBlock(ctx, ox, oy, cx, cy, w, h, chairP);

        // Backrest: a thicker, darker band on the edge facing away from the table.
        if (side === 'top') {
          fx(ctx, ox, oy, cx + 1, cy + 1, w - 2, 2, chairP.dark);
          fx(ctx, ox, oy, cx + 1, cy + 1, w - 2, 1, chairP.light);
        } else if (side === 'bottom') {
          fx(ctx, ox, oy, cx + 1, cy + h - 3, w - 2, 2, chairP.dark);
          fx(ctx, ox, oy, cx + 1, cy + h - 3, w - 2, 1, chairP.hi);
        } else if (side === 'left') {
          fx(ctx, ox, oy, cx + 1, cy + 1, 2, h - 2, chairP.dark);
          fx(ctx, ox, oy, cx + 1, cy + 1, 1, h - 2, chairP.light);
        } else {
          fx(ctx, ox, oy, cx + w - 3, cy + 1, 2, h - 2, chairP.dark);
          fx(ctx, ox, oy, cx + w - 3, cy + 1, 1, h - 2, chairP.hi);
        }

        // Specular nick on the cushion - one pixel of life, same trick as the other props.
        fx(ctx, ox, oy, cx + (horizontal ? 2 : 1), cy + (horizontal ? h - 2 : 2), 1, 1, chairP.hi);
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
    const oxp = Math.round(px - (AV_W / 2) * PX);
    const oyp = Math.round(py + 13 - AV_H * PX);

    drawAvatarSprite(ctx, oxp, oyp, PX, user.avatar, {
      direction,
      walkPhase: displayPos.isMoving ? Math.floor(Date.now() / 120) % 4 : -1,
      presence: user.presenceStatus,
      showEmoji: true,
    });
    tagAnchorY = oyp - 6;
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

// Main Render Loop. `frameDt` is the seconds since the previous animation frame; it is zero for
// renders triggered by a prop change, which must not advance the per-frame motion (headings,
// skid detection) a second time.
function renderCanvas(frameDt = 0) {
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
  // Display size follows zoom; the internal resolution above is unaffected by it.
  applyCanvasSize();
  ctx.imageSmoothingEnabled = false;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

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

    renderUser(ctx, user, isSelfUser, currentPos, isSelfUser && isGhostMode.value);
  });

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

  // Hit test in base map px (the space sprites are drawn in), so it holds at any zoom.
  const rect = canvas.getBoundingClientRect();
  const x = mapPxFromClient(e.clientX, rect.left, rect.width, canvas.width);
  const y = mapPxFromClient(e.clientY, rect.top, rect.height, canvas.height);

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
