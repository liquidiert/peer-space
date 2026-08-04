<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import type { User, GridMap, MapObject, TileType } from '../types';

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

interface Ramp {
  dark: string;
  base: string;
  light: string;
  hi: string;
}

const PALETTE: Record<string, Ramp> = {
  oak: { dark: '#8a5a2b', base: '#b9834a', light: '#d3a068', hi: '#e8c48f' },
  // Distinctly blue so carpeted areas never read as concrete at a glance.
  carpet: { dark: '#28405e', base: '#39597f', light: '#4d75a3', hi: '#6b93c0' },
  marble: { dark: '#94a3b8', base: '#e2e8f0', light: '#f1f5f9', hi: '#ffffff' },
  grass: { dark: '#3f6212', base: '#4d7c0f', light: '#65a30d', hi: '#84cc16' },
  // Neutral grey (deliberately desaturated) to stay clearly apart from the blue carpet.
  concrete: { dark: '#4a4f57', base: '#61666e', light: '#7a8089', hi: '#99a0a9' },
  brick: { dark: '#7f1d1d', base: '#b91c1c', light: '#dc2626', hi: '#f87171' },
  darkwood: { dark: '#3b1a06', base: '#6b3410', light: '#8b4a18', hi: '#b06a2c' },
  water: { dark: '#0c4a6e', base: '#0369a1', light: '#0ea5e9', hi: '#7dd3fc' },
  steel: { dark: '#334155', base: '#64748b', light: '#94a3b8', hi: '#cbd5e1' },
  indigo: { dark: '#312e81', base: '#4f46e5', light: '#6366f1', hi: '#a5b4fc' },
  amber: { dark: '#b45309', base: '#f59e0b', light: '#fbbf24', hi: '#fde68a' },
  leaf: { dark: '#14532d', base: '#15803d', light: '#22c55e', hi: '#86efac' },
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

function renderTile(ctx: CanvasRenderingContext2D, type: TileType, x: number, y: number) {
  const ox = x * CELL_SIZE;
  const oy = y * CELL_SIZE;

  switch (type) {
    case 'floor_wood': {
      const p = PALETTE.oak;
      fx(ctx, ox, oy, 0, 0, 16, 16, p.base);

      // Two horizontal planks per tile, with the end-joint staggered per row so the
      // floor reads as continuous boards rather than a repeating stamp.
      const jointA = (x * 7 + y * 3) % 16;
      const jointB = (x * 5 + y * 11 + 8) % 16;

      for (const [top, joint] of [
        [0, jointA],
        [8, jointB],
      ] as const) {
        fx(ctx, ox, oy, 0, top, 16, 1, p.light); // plank top catch-light
        fx(ctx, ox, oy, 0, top + 7, 16, 1, p.dark); // plank bottom shadow / seam
        fx(ctx, ox, oy, joint, top, 1, 7, p.dark); // butt joint between boards
        // Grain: a couple of stable dashes per plank.
        const g1 = Math.floor(tileHash(x, y, top) * 10);
        const g2 = Math.floor(tileHash(x, y, top + 99) * 10) + 4;
        fx(ctx, ox, oy, g1, top + 2, 4, 1, p.dark);
        fx(ctx, ox, oy, g2, top + 5, 3, 1, p.hi);
      }
      break;
    }

    case 'floor_carpet': {
      const p = PALETTE.carpet;
      // Plush pile: a light base with a soft dither. Kept deliberately low-contrast -
      // carpet covers large areas, so heavy texture here turns the floor into visual noise.
      fx(ctx, ox, oy, 0, 0, 16, 16, p.light);
      dither(ctx, ox, oy, 0, 0, 16, 16, p.base, (x + y) % 2);

      // Woven pile: short horizontal loops in offset rows. The directional weave is what
      // distinguishes carpet from concrete's random speckle, independent of colour.
      for (let row = 1; row < 16; row += 3) {
        const shift = (row + x * 2 + y) % 4;
        for (let i = shift; i < 16; i += 4) {
          fx(ctx, ox, oy, i, row, 2, 1, p.hi);
        }
      }
      fx(ctx, ox, oy, 0, 15, 16, 1, p.dark);
      fx(ctx, ox, oy, 15, 0, 1, 16, p.dark);
      break;
    }

    case 'floor_tile': {
      const p = PALETTE.marble;
      fx(ctx, ox, oy, 0, 0, 16, 16, p.dark); // grout
      // Four 7x7 ceramic tiles with a 1px grout gap, each with a corner specular.
      for (const [tx, ty] of [
        [0, 0],
        [8, 0],
        [0, 8],
        [8, 8],
      ] as const) {
        fx(ctx, ox, oy, tx, ty, 7, 7, p.light);
        fx(ctx, ox, oy, tx, ty, 7, 1, p.hi);
        fx(ctx, ox, oy, tx, ty, 1, 7, p.hi);
        fx(ctx, ox, oy, tx + 6, ty + 1, 1, 6, p.base);
        fx(ctx, ox, oy, tx + 1, ty + 6, 6, 1, p.base);
        fx(ctx, ox, oy, tx + 2, ty + 2, 2, 1, p.hi); // specular glint
      }
      break;
    }

    case 'floor_grass': {
      const p = PALETTE.grass;
      fx(ctx, ox, oy, 0, 0, 16, 16, p.base);
      dither(ctx, ox, oy, 0, 0, 16, 16, p.dark, (x * 3 + y) % 2);

      // A few stable blades, plus an occasional flower for variation.
      const blades = 3 + Math.floor(tileHash(x, y, 1) * 3);
      for (let i = 0; i < blades; i++) {
        const bx = Math.floor(tileHash(x, y, 10 + i) * 14) + 1;
        const by = Math.floor(tileHash(x, y, 20 + i) * 11) + 2;
        fx(ctx, ox, oy, bx, by, 1, 3, p.light);
        fx(ctx, ox, oy, bx + 1, by - 1, 1, 3, p.hi);
      }
      if (tileHash(x, y, 77) > 0.88) {
        const fxp = Math.floor(tileHash(x, y, 78) * 12) + 2;
        const fyp = Math.floor(tileHash(x, y, 79) * 12) + 2;
        fx(ctx, ox, oy, fxp, fyp, 2, 2, '#fde68a');
        fx(ctx, ox, oy, fxp, fyp, 1, 1, '#fbbf24');
      }
      break;
    }

    case 'floor_concrete': {
      const p = PALETTE.concrete;
      fx(ctx, ox, oy, 0, 0, 16, 16, p.base);
      dither(ctx, ox, oy, 0, 0, 16, 16, p.light, (x + y * 2) % 2);

      // Expansion joints on a 2-tile rhythm, so slabs read at map scale.
      if (x % 2 === 0) fx(ctx, ox, oy, 0, 0, 1, 16, p.dark);
      if (y % 2 === 0) fx(ctx, ox, oy, 0, 0, 16, 1, p.dark);

      const specks = Math.floor(tileHash(x, y, 5) * 4);
      for (let i = 0; i < specks; i++) {
        const sx = Math.floor(tileHash(x, y, 30 + i) * 14) + 1;
        const sy = Math.floor(tileHash(x, y, 40 + i) * 14) + 1;
        fx(ctx, ox, oy, sx, sy, 1, 1, p.hi);
      }
      break;
    }

    case 'wall_brick': {
      const p = PALETTE.brick;
      fx(ctx, ox, oy, 0, 0, 16, 16, '#5b1414'); // mortar

      // Four courses of staggered bricks. Each brick gets its own top light /
      // bottom shade so the wall reads as masonry rather than a flat red square.
      for (let course = 0; course < 4; course++) {
        const by = course * 4;
        const offset = course % 2 === 0 ? 0 : -4;
        for (let bx = offset; bx < 16; bx += 8) {
          const left = Math.max(bx, 0);
          const right = Math.min(bx + 7, 16);
          const bw = right - left;
          if (bw <= 0) continue;
          fx(ctx, ox, oy, left, by, bw, 3, p.base);
          fx(ctx, ox, oy, left, by, bw, 1, p.light);
          fx(ctx, ox, oy, left, by + 2, bw, 1, p.dark);
        }
      }

      // Top cap: reads as the lit top face of a solid block seen from above.
      fx(ctx, ox, oy, 0, 0, 16, 2, p.hi);
      fx(ctx, ox, oy, 0, 2, 16, 1, p.light);
      ox1(ctx, ox, oy, 0, 0, 16, 16, OUTLINE);
      break;
    }

    case 'wall_wood': {
      const p = PALETTE.darkwood;
      fx(ctx, ox, oy, 0, 0, 16, 16, p.base);

      // Vertical planking with a lit left edge and shaded right edge per board.
      for (let i = 0; i < 16; i += 4) {
        fx(ctx, ox, oy, i, 0, 1, 16, p.light);
        fx(ctx, ox, oy, i + 3, 0, 1, 16, p.dark);
      }
      // Cross beam + nail heads.
      fx(ctx, ox, oy, 0, 6, 16, 3, p.light);
      fx(ctx, ox, oy, 0, 6, 16, 1, p.hi);
      fx(ctx, ox, oy, 0, 8, 16, 1, p.dark);
      fx(ctx, ox, oy, 2, 7, 1, 1, p.dark);
      fx(ctx, ox, oy, 13, 7, 1, 1, p.dark);

      fx(ctx, ox, oy, 0, 0, 16, 2, p.hi); // top cap
      ox1(ctx, ox, oy, 0, 0, 16, 16, OUTLINE);
      break;
    }

    case 'water': {
      const p = PALETTE.water;
      fx(ctx, ox, oy, 0, 0, 16, 16, p.base);
      dither(ctx, ox, oy, 0, 0, 16, 16, p.dark, (x + y) % 2);

      // Gentle drift so water feels alive; quantised to art pixels so it stays
      // chunky pixel art instead of sliding smoothly.
      const t = Math.floor(Date.now() / 240);
      for (let i = 0; i < 3; i++) {
        const seed = tileHash(x, y, 60 + i);
        const ry = Math.floor(seed * 14) + 1;
        const drift = (Math.floor(seed * 7) + t) % 20;
        const rx = drift - 4;
        const rw = 4 + Math.floor(seed * 3);
        if (rx + rw <= 0 || rx >= 16) continue;
        const left = Math.max(rx, 0);
        const right = Math.min(rx + rw, 16);
        fx(ctx, ox, oy, left, ry, right - left, 1, p.light);
        fx(ctx, ox, oy, left, ry - 1, Math.max(1, (right - left) - 2), 1, p.hi);
      }
      break;
    }
  }
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

  // Contact shadow - offset flat block, the cel-shaded way to ground a sprite.
  fx(ctx, ox, oy, 1, H - 2, W - 1, 2, 'rgba(15, 23, 42, 0.35)');
  fx(ctx, ox, oy, W - 2, 2, 2, H - 2, 'rgba(15, 23, 42, 0.25)');

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
      fx(ctx, ox, oy, matX, matY, matW, 5, isClaimed ? PALETTE.indigo.dark : '#1e293b');
      ox1(ctx, ox, oy, matX, matY, matW, 5, OUTLINE);
      fx(ctx, ox, oy, matX + 1, matY + 1, matW - 2, 1, isClaimed ? PALETTE.indigo.light : '#38bdf8');

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
          fx(ctx, ox, oy, cx - 9, scrY + 4, 4, 1, '#f472b6');
        });
        drawScreen(cx + 1, 10, 7, PALETTE.indigo, () => {
          fx(ctx, ox, oy, cx + 3, scrY + 2, 6, 1, PALETTE.indigo.hi);
          fx(ctx, ox, oy, cx + 3, scrY + 4, 3, 1, '#86efac');
        });
        fx(ctx, ox, oy, cx - 1, scrY + 7, 2, 2, PALETTE.steel.dark); // shared stand
      } else if (equipment === 'designer_tablet') {
        drawScreen(cx - 10, 20, 8, PALETTE.leaf, () => {
          fx(ctx, ox, oy, cx - 8, scrY + 2, 4, 4, '#f43f5e');
          fx(ctx, ox, oy, cx - 3, scrY + 2, 4, 4, '#eab308');
          fx(ctx, ox, oy, cx + 2, scrY + 2, 4, 4, '#06b6d4');
        });
      } else if (equipment === 'gaming_rig') {
        // RGB spill behind the screen
        fx(ctx, ox, oy, cx - 10, scrY - 1, 20, 10, 'rgba(236, 72, 153, 0.35)');
        drawScreen(cx - 9, 18, 8, { ...PALETTE.indigo, dark: '#4c1d95' }, () => {
          fx(ctx, ox, oy, cx - 7, scrY + 2, 14, 1, '#ec4899');
          fx(ctx, ox, oy, cx - 7, scrY + 4, 9, 1, '#22d3ee');
          fx(ctx, ox, oy, cx - 7, scrY + 5, 5, 1, '#a3e635');
        });
      } else {
        // Laptop: lid + hinge + deck
        drawScreen(cx - 7, 14, 7, PALETTE.water, () => {
          fx(ctx, ox, oy, cx - 5, scrY + 2, 8, 1, PALETTE.water.hi);
          fx(ctx, ox, oy, cx - 5, scrY + 4, 5, 1, '#e0f2fe');
        });
        fx(ctx, ox, oy, cx - 8, scrY + 7, 16, 2, PALETTE.steel.base);
        ox1(ctx, ox, oy, cx - 8, scrY + 7, 16, 2, OUTLINE);
      }

      // Coffee mug (top-right) and sticky note (top-left)
      fx(ctx, ox, oy, W - 6, 3, 4, 4, '#ef4444');
      ox1(ctx, ox, oy, W - 6, 3, 4, 4, OUTLINE);
      fx(ctx, ox, oy, W - 5, 4, 2, 1, '#78350f'); // coffee surface
      fx(ctx, ox, oy, W - 2, 4, 1, 2, '#b91c1c'); // handle

      fx(ctx, ox, oy, 2, 3, 4, 4, '#fde68a');
      ox1(ctx, ox, oy, 2, 3, 4, 4, OUTLINE);
      fx(ctx, ox, oy, 3, 4, 2, 1, '#ca8a04');
      fx(ctx, ox, oy, 3, 5, 2, 1, '#ca8a04');

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
        ctx.fillStyle = '#fbbf24';
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
        ctx.fillStyle = '#e2e8f0';
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
      fx(ctx, ox, oy, 4, 10, 8, 1, '#3f2410'); // soil in the rim
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
      fx(ctx, ox, oy, 4, 6, 4, 1, '#86efac');
      fx(ctx, ox, oy, 9, 6, 1, 1, '#fbbf24');
      fx(ctx, ox, oy, 3, 3, 10, 1, '#7dd3fc'); // glare band

      fx(ctx, ox, oy, 13, 8, 1, 1, '#22c55e'); // power LED

      shadedBlock(ctx, ox, oy, 7, 10, 2, 2, p); // neck
      shadedBlock(ctx, ox, oy, 4, 12, 8, 2, p); // foot
      break;
    }

    case 'whiteboard': {
      // Frame + board + marker tray
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 3, PALETTE.steel);
      fx(ctx, ox, oy, 2, 2, W - 4, H - 8, '#ffffff');
      fx(ctx, ox, oy, 2, 2, W - 4, 1, '#f8fafc');
      // Doodles
      fx(ctx, ox, oy, 4, 5, Math.max(4, W - 12), 1, '#ef4444');
      fx(ctx, ox, oy, 4, 7, Math.max(3, W - 9), 1, '#10b981');
      fx(ctx, ox, oy, 4, 9, Math.max(3, W - 14), 1, '#3b82f6');
      // Marker tray with three markers
      shadedBlock(ctx, ox, oy, 1, H - 4, W - 2, 2, PALETTE.steel);
      fx(ctx, ox, oy, 3, H - 4, 3, 1, '#ef4444');
      fx(ctx, ox, oy, 7, H - 4, 3, 1, '#3b82f6');
      fx(ctx, ox, oy, 11, H - 4, 3, 1, '#10b981');
      break;
    }

    case 'sticky_notes': {
      // Cork board with pinned notes at slight offsets
      shadedBlock(ctx, ox, oy, 0, 0, W, H - 1, { dark: '#78350f', base: '#b45309', light: '#d97706', hi: '#f59e0b' });
      const notes: Array<[number, number, string]> = [
        [2, 2, '#fde68a'],
        [8, 3, '#fca5a5'],
        [3, 8, '#a7f3d0'],
        [9, 9, '#bfdbfe'],
      ];
      notes.forEach(([nx, ny, color]) => {
        if (nx + 5 > W || ny + 5 > H) return;
        fx(ctx, ox, oy, nx, ny, 5, 5, color);
        ox1(ctx, ox, oy, nx, ny, 5, 5, OUTLINE);
        fx(ctx, ox, oy, nx + 1, ny + 2, 3, 1, 'rgba(15,23,42,0.35)');
        fx(ctx, ox, oy, nx + 1, ny + 3, 2, 1, 'rgba(15,23,42,0.35)');
        fx(ctx, ox, oy, nx + 2, ny, 1, 1, '#ef4444'); // pin
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
          fx(ctx, ox, oy, boardX + i * cs, boardY + j * cs, cs, cs, (i + j) % 2 ? '#e0e7ff' : '#4338ca');
        }
      }
      ox1(ctx, ox, oy, boardX, boardY, cells * cs, cells * cs, OUTLINE);
      // A couple of pieces
      fx(ctx, ox, oy, boardX + cs, boardY + cs, cs, cs, '#f43f5e');
      fx(ctx, ox, oy, boardX + cs * 4, boardY + cs * 3, cs, cs, '#fbbf24');
      break;
    }

    case 'jukebox': {
      const body: Ramp = { dark: '#9d174d', base: '#db2777', light: '#ec4899', hi: '#f9a8d4' };
      // Arched top
      fx(ctx, ox, oy, 2, 1, W - 4, 2, body.light);
      fx(ctx, ox, oy, 1, 3, W - 2, H - 5, body.base);
      ox1(ctx, ox, oy, 1, 3, W - 2, H - 5, OUTLINE);
      ox1(ctx, ox, oy, 2, 1, W - 4, 3, OUTLINE);
      // Glowing arch light
      fx(ctx, ox, oy, 3, 2, W - 6, 1, '#fde68a');
      // Speaker grille
      fx(ctx, ox, oy, 3, 5, W - 6, 5, body.dark);
      for (let i = 4; i < W - 4; i += 2) {
        fx(ctx, ox, oy, i, 5, 1, 5, '#4c0519');
      }
      // Control buttons
      fx(ctx, ox, oy, 4, 11, 2, 2, '#22d3ee');
      fx(ctx, ox, oy, 7, 11, 2, 2, '#fbbf24');
      fx(ctx, ox, oy, 10, 11, 2, 2, '#a3e635');
      break;
    }

    case 'tv': {
      // Wall-mounted flat screen
      shadedBlock(ctx, ox, oy, 0, 1, W, H - 4, PALETTE.steel);
      fx(ctx, ox, oy, 2, 3, W - 4, H - 8, '#0c4a6e');
      // Screen content + scanlines
      fx(ctx, ox, oy, 3, 4, W - 6, 2, '#0ea5e9');
      fx(ctx, ox, oy, 3, 7, Math.max(2, W - 10), 2, '#38bdf8');
      for (let j = 4; j < H - 5; j += 2) {
        fx(ctx, ox, oy, 2, j, W - 4, 1, 'rgba(12, 74, 110, 0.35)');
      }
      fx(ctx, ox, oy, 2, 3, W - 4, 1, '#7dd3fc'); // glare
      // Stand
      shadedBlock(ctx, ox, oy, Math.floor(W / 2) - 2, H - 3, 4, 1, PALETTE.steel);
      shadedBlock(ctx, ox, oy, Math.floor(W / 2) - 4, H - 2, 8, 1, PALETTE.steel);
      break;
    }

    case 'coffee_machine': {
      const body: Ramp = { dark: '#4c1d0a', base: '#92400e', light: '#c2410c', hi: '#fb923c' };
      const steel = PALETTE.steel;

      // Tall body with a chrome upper deck, so the machine silhouette is obvious.
      shadedBlock(ctx, ox, oy, 1, 0, 14, 12, body);
      shadedBlock(ctx, ox, oy, 2, 1, 12, 3, steel); // chrome top / bean hopper
      fx(ctx, ox, oy, 3, 2, 4, 1, '#22c55e'); // ready lamp
      fx(ctx, ox, oy, 11, 2, 2, 1, '#ef4444'); // power lamp

      // Group head with the portafilter below it.
      shadedBlock(ctx, ox, oy, 5, 5, 6, 2, steel);
      fx(ctx, ox, oy, 7, 7, 2, 1, '#3f2410'); // espresso stream

      // Cup sitting on the drip tray.
      shadedBlock(ctx, ox, oy, 6, 8, 4, 3, { dark: '#94a3b8', base: '#f1f5f9', light: '#ffffff', hi: '#ffffff' });
      fx(ctx, ox, oy, 7, 9, 2, 1, '#78350f'); // coffee surface
      fx(ctx, ox, oy, 10, 9, 1, 1, '#e2e8f0'); // handle

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
          const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
          const color = colors[(i * 2 + si * 3) % colors.length];
          if (bx + bw > W - 2) break;
          fx(ctx, ox, oy, bx, sy + 5 - bh, bw, bh, color);
          ox1(ctx, ox, oy, bx, sy + 5 - bh, bw, bh, OUTLINE);
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

// Render Cel-Shaded User Character Avatar
// Draws a rectangle with independently-toggleable rounded corners, falling back to a
// plain rect if the browser lacks native roundRect support.
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: number | [number, number, number, number]
) {
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(x, y, w, h, radii);
  } else {
    ctx.rect(x, y, w, h);
  }
}

// Character avatar, drawn as flat-colored rounded blocks to match the Avatar Studio
// preview (see AvatarBuilder.vue) instead of the previous circular/blob rendering.
function renderUser(
  ctx: CanvasRenderingContext2D,
  user: User,
  isSelf: boolean,
  displayPos: { x: number; y: number; isMoving: boolean },
  isGhost = false
) {
  let px = displayPos.x * CELL_SIZE + CELL_SIZE / 2;
  let py = displayPos.y * CELL_SIZE + CELL_SIZE / 2;

  // Add rhythmic walking bounce animation when moving
  if (displayPos.isMoving) {
    const walkingBounce = Math.abs(Math.sin(Date.now() / 90)) * 2;
    py -= walkingBounce;
  }

  ctx.save();

  // Ghost Mode: your own avatar turns translucent while phasing through others
  if (isSelf && isGhost) {
    ctx.globalAlpha = 0.45;
  }

  // Proximity Voice Halo Ring (If speaking)
  if (user.isSpeaking) {
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(px, py - 2, 26, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (isSelf) {
    // Proximity 4-tile spatial voice radius visual circle
    ctx.strokeStyle = '#6366f1';
    ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.arc(px, py, 4 * CELL_SIZE, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const hairColor = user.avatar.hairColor || '#1e293b';
  const hairStyle = user.avatar.hairStyle || 'short';
  const hatStyle = user.avatar.hatStyle || 'none';
  const BORDER = '#0f172a';

  const HEAD_W = 20;
  const HEAD_H = 18;
  const headX = px - HEAD_W / 2;
  const headY = py - HEAD_H - 2;

  const BODY_W = 28;
  const BODY_H = 17;
  const bodyX = px - BODY_W / 2;
  const bodyY = py - 2;

  // Hair Back Layer (Long hair locks / Afro halo behind head)
  if (hatStyle === 'none') {
    if (hairStyle === 'long') {
      ctx.fillStyle = hairColor;
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 1.5;

      roundedRect(ctx, headX - 3, headY + 3, 4, 13, [0, 0, 3, 3]);
      ctx.fill();
      ctx.stroke();

      roundedRect(ctx, headX + HEAD_W - 1, headY + 3, 4, 13, [0, 0, 3, 3]);
      ctx.fill();
      ctx.stroke();
    } else if (hairStyle === 'afro') {
      ctx.fillStyle = hairColor;
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 2;
      roundedRect(ctx, px - 15, headY - 6, 30, 26, 13);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Body (drawn before the head so the head's border cleanly overlaps the seam)
  ctx.fillStyle = user.avatar.outfitColor || '#3b82f6';
  roundedRect(ctx, bodyX, bodyY, BODY_W, BODY_H, [5, 5, 0, 0]);
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 2;
  roundedRect(ctx, bodyX, bodyY, BODY_W, BODY_H, [5, 5, 0, 0]);
  ctx.stroke();

  // Head / Face
  ctx.fillStyle = user.avatar.skinColor || '#f87171';
  roundedRect(ctx, headX, headY, HEAD_W, HEAD_H, 6);
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 2;
  roundedRect(ctx, headX, headY, HEAD_W, HEAD_H, 6);
  ctx.stroke();

  // Hair Top Layer (Short cap, Long top cap, Curly locks)
  if (hatStyle === 'none' && hairStyle !== 'bald') {
    if (hairStyle === 'short' || hairStyle === 'long') {
      ctx.fillStyle = hairColor;
      roundedRect(ctx, headX - 1, headY - 4, HEAD_W + 2, 7, [4, 4, 0, 0]);
      ctx.fill();
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 1.5;
      roundedRect(ctx, headX - 1, headY - 4, HEAD_W + 2, 7, [4, 4, 0, 0]);
      ctx.stroke();
    } else if (hairStyle === 'curly') {
      ctx.fillStyle = hairColor;
      roundedRect(ctx, headX - 1, headY - 5, HEAD_W + 2, 8, [5, 5, 0, 0]);
      ctx.fill();
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 1.5;
      roundedRect(ctx, headX - 1, headY - 5, HEAD_W + 2, 8, [5, 5, 0, 0]);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      [headX + 3, headX + HEAD_W / 2 - 1, headX + HEAD_W - 5].forEach((cx) => {
        ctx.beginPath();
        ctx.arc(cx, headY - 1, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // Face Eyewear / Glasses or plain Eyes
  const eyeY = headY + 7;
  if (user.avatar.glasses) {
    ctx.fillStyle = BORDER;
    ctx.fillRect(px - 8, eyeY, 6, 5);
    ctx.fillRect(px + 2, eyeY, 6, 5);
    ctx.fillRect(px - 2, eyeY + 2, 4, 1.5);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(px - 7, eyeY + 1, 4, 3);
    ctx.fillRect(px + 3, eyeY + 1, 4, 3);
  } else {
    ctx.fillStyle = BORDER;
    ctx.fillRect(px - 6, eyeY, 3, 3);
    ctx.fillRect(px + 3, eyeY, 3, 3);
  }

  // Mouth (flat line, matching the Avatar Studio preview)
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px - 4, headY + 14);
  ctx.lineTo(px + 4, headY + 14);
  ctx.stroke();

  // Headwear / Hat
  if (user.avatar.hatStyle === 'cap') {
    ctx.fillStyle = '#dc2626';
    roundedRect(ctx, headX, headY - 6, HEAD_W, 6, [4, 4, 0, 0]);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, headX, headY - 6, HEAD_W, 6, [4, 4, 0, 0]);
    ctx.stroke();

    ctx.fillStyle = '#991b1b';
    ctx.fillRect(headX - 2, headY - 1, HEAD_W + 4, 3);
  } else if (user.avatar.hatStyle === 'beanie') {
    ctx.fillStyle = '#059669';
    roundedRect(ctx, headX, headY - 8, HEAD_W, 9, [6, 6, 0, 0]);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, headX, headY - 8, HEAD_W, 9, [6, 6, 0, 0]);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(px - 3, headY - 12, 6, 6);
    ctx.strokeRect(px - 3, headY - 12, 6, 6);
  }

  // Presence Status Dot (top-right corner of the head, Discord-style)
  const presenceColors: Record<string, string> = {
    available: '#22c55e',
    busy: '#f59e0b',
    dnd: '#ef4444',
  };
  const presenceColor = presenceColors[user.presenceStatus] || presenceColors.available;
  const dotX = headX + HEAD_W - 1;
  const dotY = headY + 1;
  ctx.fillStyle = BORDER;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = presenceColor;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
  ctx.fill();
  if (user.presenceStatus === 'dnd') {
    // A short bar reads as "do not disturb" even at a glance, matching common chat apps.
    ctx.fillStyle = BORDER;
    ctx.fillRect(dotX - 1.5, dotY - 0.75, 3, 1.5);
  }

  // Status Emoji Badge (bottom-right corner, overlapping the head/body seam)
  const badgeX = px + BODY_W / 2 - 10;
  const badgeY = bodyY + 3;
  ctx.fillStyle = BORDER;
  roundedRect(ctx, badgeX - 1, badgeY - 1, 16, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#fbbf24';
  roundedRect(ctx, badgeX, badgeY, 14, 14, 4);
  ctx.fill();
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(user.avatar.statusEmoji || '👋', badgeX + 7, badgeY + 8);

  // Cel-Shaded Pixel Name Tag Banner Above Head
  const nameText = isSelf ? `${user.name} (YOU)` : user.name;
  ctx.font = 'bold 12px "Pixelify Sans", cursive, sans-serif';
  const textWidth = ctx.measureText(nameText).width;

  const tagX = px - textWidth / 2 - 8;
  const tagY = py - 42;

  // Dark shadow offset
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(tagX + 3, tagY + 3, textWidth + 16, 22);

  // Banner Box
  ctx.fillStyle = isSelf ? '#fef3c7' : '#ffffff';
  ctx.fillRect(tagX, tagY, textWidth + 16, 22);

  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.strokeRect(tagX, tagY, textWidth + 16, 22);

  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(nameText, px, tagY + 11);

  ctx.restore();
}

// Main Render Loop
function renderCanvas() {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Enable crisp nearest-neighbor pixel rendering
  ctx.imageSmoothingEnabled = false;

  const map = props.currentMap;
  canvas.width = map.width * CELL_SIZE;
  canvas.height = map.height * CELL_SIZE;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw Tiles
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tileType = map.tiles[y]?.[x] || 'floor_tile';
      renderTile(ctx, tileType, x, y);
    }
  }

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
