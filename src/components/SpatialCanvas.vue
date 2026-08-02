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
  (e: 'move', payload: { x: number; y: number; direction: 'up' | 'down' | 'left' | 'right' }): void;
  (e: 'navigateTile', payload: { x: number; y: number }): void;
  (e: 'interactObject', object: MapObject): void;
  (e: 'placeObject', newObj: MapObject): void;
  (e: 'removeObject', objectId: string): void;
  (e: 'changeTile', payload: { x: number; y: number; tileType: TileType }): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const scrollContainerRef = ref<HTMLDivElement | null>(null);
const CELL_SIZE = 48; // Each spatial tile is 48x48px

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

// Render Cel-Shaded Tile Helper
function renderTile(ctx: CanvasRenderingContext2D, type: TileType, x: number, y: number) {
  const px = x * CELL_SIZE;
  const py = y * CELL_SIZE;

  // Base background fill
  switch (type) {
    case 'floor_wood':
      // Soft natural warm Scandinavian oak wood floor with smooth tile blending
      ctx.fillStyle = '#c89f6d';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      // Plank 1 (Top half)
      ctx.fillStyle = '#d8ae7d';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE / 2 - 1);
      ctx.fillStyle = '#e6c8a2'; // Soft top grain highlight
      ctx.fillRect(px + ((x % 2) * 12), py + 3, CELL_SIZE - 12, 1);

      // Plank 2 (Bottom half)
      ctx.fillStyle = '#b88d5c';
      ctx.fillRect(px, py + CELL_SIZE / 2, CELL_SIZE, CELL_SIZE / 2);
      ctx.fillStyle = '#cb9f6e'; // Soft bottom grain highlight
      ctx.fillRect(px + (((x + 1) % 2) * 12), py + CELL_SIZE / 2 + 3, CELL_SIZE - 12, 1);

      // Horizontal plank seam
      ctx.fillStyle = 'rgba(110, 70, 30, 0.2)';
      ctx.fillRect(px, py + CELL_SIZE / 2 - 1, CELL_SIZE, 1);

      // Vertical staggered plank joints
      ctx.fillRect(px + ((x * 16) % CELL_SIZE), py, 1, CELL_SIZE / 2 - 1);
      ctx.fillRect(px + (((x * 16) + 24) % CELL_SIZE), py + CELL_SIZE / 2, 1, CELL_SIZE / 2);

      // Soft, subtle outer blend border
      ctx.strokeStyle = 'rgba(110, 70, 30, 0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
      break;

    case 'floor_carpet':
      // Soft muted slate-blue plush office carpet
      ctx.fillStyle = '#3b4859';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      // Light carpet weave inner pad
      ctx.fillStyle = '#48566a';
      ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // Soft pixel weave highlights
      ctx.fillStyle = '#607085';
      ctx.fillRect(px + 10, py + 10, 4, 4);
      ctx.fillRect(px + 30, py + 10, 4, 4);
      ctx.fillRect(px + 20, py + 22, 4, 4);
      ctx.fillRect(px + 10, py + 34, 4, 4);
      ctx.fillRect(px + 30, py + 34, 4, 4);

      // Soft seamless tile border
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
      break;

    case 'floor_tile':
      // Soft ceramic marble tile with smooth grout lines
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      // Tile face
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // Soft sheen highlight
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + 3, py + 3, CELL_SIZE - 6, 2);
      ctx.fillRect(px + 3, py + 3, 2, CELL_SIZE - 6);

      // Soft grout border
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
      break;

    case 'floor_grass':
      // Soft natural meadow pixel grass
      ctx.fillStyle = '#3f6212';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      ctx.fillStyle = '#4d7c0f';
      ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // Grass tufts
      ctx.fillStyle = '#65a30d';
      ctx.fillRect(px + 8, py + 10, 3, 6);
      ctx.fillRect(px + 11, py + 7, 3, 9);
      ctx.fillRect(px + 28, py + 22, 3, 8);
      ctx.fillRect(px + 31, py + 19, 3, 11);

      ctx.strokeStyle = 'rgba(20, 60, 10, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
      break;

    case 'floor_concrete':
      // Soft industrial slate concrete
      ctx.fillStyle = '#475569';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      ctx.fillStyle = '#64748b';
      ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);

      // Specks
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(px + 12, py + 12, 3, 3);
      ctx.fillRect(px + 28, py + 28, 3, 3);

      ctx.strokeStyle = 'rgba(15, 23, 42, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
      break;

    case 'wall_wood':
      ctx.fillStyle = '#78350f';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
      ctx.fillStyle = '#92400e';
      ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      ctx.strokeStyle = '#451a03';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
      break;

    case 'water':
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
      ctx.fillStyle = '#0ea5e9';
      ctx.fillRect(px + 3, py + 3, CELL_SIZE - 6, CELL_SIZE - 6);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(px + 6, py + 6, CELL_SIZE - 12, 4);
      break;
      ctx.fillStyle = '#dc2626';
      // Row 1
      ctx.fillRect(px + 2, py + 2, 20, 18);
      ctx.fillRect(px + 24, py + 2, 22, 18);
      // Row 2
      ctx.fillRect(px + 2, py + 22, 10, 22);
      ctx.fillRect(px + 14, py + 22, 20, 22);
      ctx.fillRect(px + 36, py + 22, 10, 22);

      // Brick highlights
      ctx.fillStyle = '#f87171';
      ctx.fillRect(px + 4, py + 4, 16, 3);
      ctx.fillRect(px + 26, py + 4, 18, 3);
      ctx.fillRect(px + 16, py + 24, 16, 3);

      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      break;

    case 'wall_wood':
      ctx.fillStyle = '#451a03';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      ctx.fillStyle = '#78350f';
      ctx.fillRect(px + 3, py + 3, CELL_SIZE - 6, CELL_SIZE - 6);

      ctx.fillStyle = '#b45309';
      ctx.fillRect(px + 6, py + 6, CELL_SIZE - 12, 6);
      ctx.fillRect(px + 6, py + 24, CELL_SIZE - 12, 6);

      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      break;

    case 'water':
      ctx.fillStyle = '#0e7490';
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

      ctx.fillStyle = '#06b6d4';
      ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

      // Pixel ripple reflections
      ctx.fillStyle = '#67e8f9';
      ctx.fillRect(px + 8, py + 8, 12, 4);
      ctx.fillRect(px + 24, py + 20, 16, 4);
      ctx.fillRect(px + 10, py + 34, 14, 4);

      ctx.strokeStyle = '#164e63';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      break;
  }
}

// Render Cel-Shaded Object Helper
function renderObject(ctx: CanvasRenderingContext2D, obj: MapObject) {
  const px = obj.x * CELL_SIZE;
  const py = obj.y * CELL_SIZE;
  const w = obj.width * CELL_SIZE;
  const h = obj.height * CELL_SIZE;

  ctx.save();

  // Cel-shaded pixel drop shadow
  ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
  ctx.fillRect(px + 4, py + 4, w - 4, h - 4);

  switch (obj.type) {
    case 'desk': {
      // 1. Dark cel-shaded outline
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 1, py + 1, w - 2, h - 2);

      const isClaimed = !!obj.data?.deskState?.claimedByUserId;

      // 2. Dual-tone Desk Tabletop (Warm Oak / Sleek Modern)
      const surfaceEdge = isClaimed ? '#d97706' : '#64748b';
      const surfaceBase = isClaimed ? '#f59e0b' : '#cbd5e1';
      const surfaceTop = isClaimed ? '#fef08a' : '#f8fafc';

      ctx.fillStyle = surfaceEdge;
      ctx.fillRect(px + 3, py + 3, w - 6, h - 6);

      ctx.fillStyle = surfaceBase;
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);

      // Top edge highlight bevel
      ctx.fillStyle = surfaceTop;
      ctx.fillRect(px + 5, py + 5, w - 10, 3);

      // Bottom bevel shadow line
      ctx.fillStyle = isClaimed ? '#b45309' : '#94a3b8';
      ctx.fillRect(px + 5, py + h - 7, w - 10, 2);

      // 3. Desk Mat / Leather Mousepad in center
      const matW = w * 0.54;
      const matH = h * 0.55;
      const matX = px + (w - matW) / 2;
      const matY = py + 7;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(matX - 1, matY - 1, matW + 2, matH + 2);
      ctx.fillStyle = isClaimed ? '#312e81' : '#1e293b';
      ctx.fillRect(matX, matY, matW, matH);

      // Mat top accent line
      ctx.fillStyle = isClaimed ? '#6366f1' : '#38bdf8';
      ctx.fillRect(matX + 1, matY + 1, matW - 2, 2);

      // 4. Pixel Keyboard & Mouse
      const kbW = 22;
      const kbH = 7;
      const kbX = matX + (matW - kbW) / 2 - 4;
      const kbY = matY + matH - 10;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(kbX, kbY, kbW, kbH);
      ctx.fillStyle = '#475569';
      ctx.fillRect(kbX + 1, kbY + 1, kbW - 2, kbH - 2);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(kbX + 3, kbY + 2.5, 16, 2);

      // Mouse
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(kbX + kbW + 4, kbY, 5, 7);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(kbX + kbW + 4.5, kbY + 0.5, 4, 6);

      // 5. Equipment (Monitors / Laptop / Tablet / Gaming Rig)
      const equipment = obj.data?.deskState?.equipment || 'laptop';
      const centerX = px + w / 2;

      if (equipment === 'dual_monitors') {
        // Dual Monitor Stand
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(centerX - 8, matY + 3, 16, 4);

        // Left Monitor Screen
        const m1X = centerX - 23;
        const m1Y = py + 5;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(m1X, m1Y, 20, 14);
        ctx.fillStyle = '#0284c7';
        ctx.fillRect(m1X + 2, m1Y + 2, 16, 10);
        // Code screen highlights
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(m1X + 4, m1Y + 4, 10, 2);
        ctx.fillStyle = '#f43f5e';
        ctx.fillRect(m1X + 4, m1Y + 7, 7, 2);
        ctx.fillStyle = '#a855f7';
        ctx.fillRect(m1X + 4, m1Y + 10, 11, 1.5);

        // Right Monitor Screen
        const m2X = centerX + 3;
        const m2Y = py + 5;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(m2X, m2Y, 20, 14);
        ctx.fillStyle = '#4338ca';
        ctx.fillRect(m2X + 2, m2Y + 2, 16, 10);
        ctx.fillStyle = '#818cf8';
        ctx.beginPath();
        ctx.arc(m2X + 10, m2Y + 7, 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (equipment === 'designer_tablet') {
        // Ultrawide Screen
        const tw = 36;
        const th = 15;
        const tx = centerX - tw / 2;
        const ty = py + 5;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(tx, ty, tw, th);
        ctx.fillStyle = '#0f766e';
        ctx.fillRect(tx + 2, ty + 2, tw - 4, th - 4);
        // Canvas graphics
        ctx.fillStyle = '#f43f5e';
        ctx.fillRect(tx + 4, ty + 4, 6, 6);
        ctx.fillStyle = '#eab308';
        ctx.fillRect(tx + 12, ty + 4, 6, 6);
        ctx.fillStyle = '#06b6d4';
        ctx.fillRect(tx + 20, ty + 4, 6, 6);
      } else if (equipment === 'gaming_rig') {
        // Gaming Rig with RGB Glow
        const tw = 32;
        const th = 15;
        const tx = centerX - tw / 2;
        const ty = py + 5;
        ctx.fillStyle = 'rgba(236, 72, 153, 0.4)';
        ctx.fillRect(tx - 3, ty - 2, tw + 6, th + 4);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(tx, ty, tw, th);
        ctx.fillStyle = '#ec4899';
        ctx.fillRect(tx + 2, ty + 2, tw - 4, th - 4);
        ctx.fillStyle = '#f87171';
        ctx.fillRect(tx + 5, ty + 5, 12, 6);
      } else {
        // Opened Laptop
        const lw = 26;
        const lh = 14;
        const lx = centerX - lw / 2;
        const ly = py + 5;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(lx, ly, lw, lh);
        ctx.fillStyle = '#0284c7';
        ctx.fillRect(lx + 2, ly + 2, lw - 4, lh - 4);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(lx + 4, ly + 4, lw - 8, 4);
        ctx.fillStyle = '#e0f2fe';
        ctx.fillRect(lx + 6, ly + 9, 8, 2);

        // Hinge
        ctx.fillStyle = '#64748b';
        ctx.fillRect(lx - 2, ly + lh, lw + 4, 3);
      }

      // 6. Accessories (Mug at Top Right, Post-it at Top Left)
      // Coffee Mug
      const mugX = px + w - 16;
      const mugY = py + 6;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(mugX, mugY, 8, 8);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(mugX + 1, mugY + 1, 6, 6);
      ctx.fillStyle = '#78350f';
      ctx.fillRect(mugX + 2, mugY + 2, 4, 2);

      // Sticky Note
      const noteX = px + 8;
      const noteY = py + 6;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(noteX, noteY, 7, 7);
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(noteX + 1, noteY + 1, 5, 5);
      ctx.fillStyle = '#ca8a04';
      ctx.fillRect(noteX + 2, noteY + 2, 3, 1);

      // 7. Desk Status / Owner Badge
      if (obj.data?.deskState?.claimedByUserName) {
        const ownerName = obj.data.deskState.claimedByUserName;
        ctx.font = 'bold 9px "Pixelify Sans", cursive, sans-serif';
        const labelW = Math.min(w - 8, ctx.measureText(`👤 ${ownerName}`).width + 8);
        const labelX = centerX - labelW / 2;
        const labelY = py + h - 11;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(labelX + 1, labelY + 1, labelW, 11);
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(labelX, labelY, labelW, 11);
        ctx.fillStyle = '#0f172a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`👤 ${ownerName}`, centerX, labelY + 6);
      } else {
        const labelText = obj.data?.deskState?.deskLabel || obj.name || 'Workstation';
        ctx.font = '9px "Pixelify Sans", cursive, sans-serif';
        ctx.fillStyle = '#475569';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`✨ ${labelText}`, centerX, py + h - 6);
      }
      break;
    }

    case 'chair':
      // Cel-shaded Ergonomic Office Chair
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, 13, 0, Math.PI * 2);
      ctx.fill();

      // Cushion base
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, 10, 0, Math.PI * 2);
      ctx.fill();

      // Inner seat cushion
      ctx.fillStyle = '#6366f1';
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, 7, 0, Math.PI * 2);
      ctx.fill();

      // Armrests
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + w / 2 - 14, py + h / 2 - 3, 4, 6);
      ctx.fillRect(px + w / 2 + 10, py + h / 2 - 3, 4, 6);
      break;

    case 'computer':
      // Small standalone PC setup
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(px + 6, py + 6, w - 12, h - 12);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(px + 8, py + 8, w - 16, h - 16);
      break;

    case 'couch':
      // Dark outer border
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      // Base couch color
      ctx.fillStyle = '#818cf8';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);

      // Seat cushions cel shading
      ctx.fillStyle = '#4f46e5';
      ctx.fillRect(px + 6, py + h / 2, w / 2 - 8, h / 2 - 6);
      ctx.fillRect(px + w / 2 + 2, py + h / 2, w / 2 - 8, h / 2 - 6);

      // Cushion highlights
      ctx.fillStyle = '#c7d2fe';
      ctx.fillRect(px + 8, py + 6, w / 2 - 12, 4);
      ctx.fillRect(px + w / 2 + 4, py + 6, w / 2 - 12, 4);
      break;

    case 'plant':
      // Pot base with thick outline
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, 11, 0, Math.PI * 2);
      ctx.fill();

      // Cel-shaded Plant Leaves
      ctx.fillStyle = '#15803d';
      ctx.fillRect(px + w / 2 - 10, py + h / 2 - 10, 10, 10);
      ctx.fillRect(px + w / 2, py + h / 2 - 12, 10, 10);
      ctx.fillRect(px + w / 2 - 6, py + h / 2, 12, 10);

      ctx.fillStyle = '#4ade80';
      ctx.fillRect(px + w / 2 - 8, py + h / 2 - 8, 6, 6);
      ctx.fillRect(px + w / 2 + 2, py + h / 2 - 10, 6, 6);
      break;

    case 'whiteboard':
      // Thick outer frame
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      // Board Surface
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + 5, py + 5, w - 10, h - 10);

      // Top Blue Banner
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(px + 5, py + 5, w - 10, 10);

      ctx.font = 'bold 13px "Silkscreen", cursive';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('BOARD', px + w / 2, py + 10);

      // Content doodles
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(px + 12, py + 22, 20, 3);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(px + 12, py + 28, 32, 3);
      break;

    case 'sticky_notes':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      ctx.fillStyle = '#fef08a';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);

      ctx.fillStyle = '#ca8a04';
      ctx.fillRect(px + 4, py + 4, w - 8, 8);

      ctx.font = 'bold 13px "Silkscreen", cursive';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0f172a';
      ctx.fillText('📌 NOTES', px + w / 2, py + h / 2);
      break;

    case 'game_table':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 3, py + 3, w - 6, h - 6);

      ctx.fillStyle = '#e0e7ff';
      ctx.fillRect(px + 6, py + 6, w - 12, h - 12);

      // Grid
      ctx.fillStyle = '#6366f1';
      ctx.fillRect(px + w / 2 - 1, py + 10, 2, h - 20);
      ctx.fillRect(px + 10, py + h / 2 - 1, w - 20, 2);

      ctx.font = 'bold 20px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎮', px + w / 2, py + h / 2);
      break;

    case 'jukebox':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      ctx.fillStyle = '#ec4899';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);

      ctx.fillStyle = '#f472b6';
      ctx.fillRect(px + 6, py + 6, w - 12, 6);

      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📻', px + w / 2, py + h / 2 + 2);
      break;

    case 'tv':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      ctx.fillStyle = '#0284c7';
      ctx.fillRect(px + 5, py + 5, w - 10, h - 10);

      // Scanlines effect
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(px + 8, py + 8, w - 16, 4);
      ctx.fillRect(px + 8, py + 18, w - 16, 4);

      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📺', px + w / 2, py + h / 2);
      break;

    case 'coffee_machine':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      ctx.fillStyle = '#d97706';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);

      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(px + 6, py + 6, w - 12, 6);

      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('☕', px + w / 2, py + h / 2);
      break;

    case 'bookshelf':
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);

      ctx.fillStyle = '#78350f';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);

      // Pixel book spines
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(px + 6, py + 6, 6, 12);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(px + 14, py + 6, 6, 12);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(px + 22, py + 6, 6, 12);

      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(px + 6, py + 26, 8, 12);
      ctx.fillStyle = '#8b5cf6';
      ctx.fillRect(px + 16, py + 26, 8, 12);
      break;

    default:
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 2, py + 2, w - 4, h - 4);
      ctx.fillStyle = '#64748b';
      ctx.fillRect(px + 4, py + 4, w - 8, h - 8);
      break;
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
  displayPos: { x: number; y: number; isMoving: boolean }
) {
  let px = displayPos.x * CELL_SIZE + CELL_SIZE / 2;
  let py = displayPos.y * CELL_SIZE + CELL_SIZE / 2;

  // Add rhythmic walking bounce animation when moving
  if (displayPos.isMoving) {
    const walkingBounce = Math.abs(Math.sin(Date.now() / 90)) * 2;
    py -= walkingBounce;
  }

  ctx.save();

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

    renderUser(ctx, user, user.socketId === props.currentUser.socketId, currentPos);
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

  emit('move', { x: targetX, y: targetY, direction: dir });
}

// Keydown Movement Listener
function handleKeyDown(e: KeyboardEvent) {
  if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
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
  updateIsMobile();
  window.addEventListener('resize', updateIsMobile);
  startAnimLoop();
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
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
