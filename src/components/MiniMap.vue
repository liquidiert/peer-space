<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { Map, Maximize2, Minimize2, Lock, Users, Compass, Eye, GripVertical, RotateCcw } from 'lucide-vue-next';
import type { User, GridMap, TileType } from '../types';

const props = defineProps<{
  currentMap: GridMap;
  users: User[];
  currentUser: User;
}>();

const emit = defineEmits<{
  (e: 'navigateTile', payload: { x: number; y: number }): void;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const minimapRef = ref<HTMLDivElement | null>(null);
const isExpanded = ref(true);
const showZones = ref(true);
const hoveredUser = ref<User | null>(null);

// Movable minimap position logic
const pos = ref<{ x: number; y: number } | null>(null);
const isDragging = ref(false);
let dragOffset = { x: 0, y: 0 };

function startDrag(e: MouseEvent | TouchEvent) {
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

  const container = minimapRef.value;
  if (!container) return;
  const rect = container.getBoundingClientRect();

  dragOffset = {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
  isDragging.value = true;

  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('touchmove', onDrag);
  window.addEventListener('touchend', stopDrag);
}

function onDrag(e: MouseEvent | TouchEvent) {
  if (!isDragging.value) return;
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

  const newX = Math.max(8, Math.min(window.innerWidth - 180, clientX - dragOffset.x));
  const newY = Math.max(8, Math.min(window.innerHeight - 100, clientY - dragOffset.y));

  pos.value = { x: newX, y: newY };
}

function stopDrag() {
  isDragging.value = false;
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', stopDrag);
  window.removeEventListener('touchmove', onDrag);
  window.removeEventListener('touchend', stopDrag);
}

function resetPos() {
  pos.value = null;
}

onUnmounted(() => {
  stopDrag();
});

const TILE_COLORS: Record<string, string> = {
  floor_wood: '#c89f6d',
  floor_carpet: '#475569',
  floor_tile: '#cbd5e1',
  floor_grass: '#22c55e',
  floor_concrete: '#64748b',
  wall_brick: '#0f172a',
  wall_wood: '#78350f',
  wall_glass: '#38bdf8',
  water: '#0284c7',
};

function renderMiniMap() {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const map = props.currentMap;
  const mapW = map.width;
  const mapH = map.height;

  // Set crisp canvas size
  const displaySize = isExpanded.value ? 200 : 120;
  canvas.width = displaySize;
  canvas.height = Math.round((mapH / mapW) * displaySize);

  const scaleX = canvas.width / mapW;
  const scaleY = canvas.height / mapH;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw Map Tiles
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const tileType = map.tiles[y]?.[x] || 'floor_tile';
      ctx.fillStyle = TILE_COLORS[tileType] || '#e2e8f0';
      ctx.fillRect(Math.floor(x * scaleX), Math.floor(y * scaleY), Math.ceil(scaleX), Math.ceil(scaleY));
    }
  }

  // 2. Draw Objects
  (map.objects || []).forEach((obj) => {
    ctx.fillStyle = obj.isBlocking ? '#1e293b' : '#64748b';
    ctx.fillRect(
      Math.floor(obj.x * scaleX),
      Math.floor(obj.y * scaleY),
      Math.max(1, Math.ceil(obj.width * scaleX)),
      Math.max(1, Math.ceil(obj.height * scaleY))
    );
  });

  // 3. Draw Private Audio Zones
  if (showZones.value && map.privateZones) {
    (map.privateZones || []).forEach((zone) => {
      ctx.fillStyle = zone.color || 'rgba(99, 102, 241, 0.3)';
      ctx.fillRect(
        Math.floor(zone.x * scaleX),
        Math.floor(zone.y * scaleY),
        Math.ceil(zone.width * scaleX),
        Math.ceil(zone.height * scaleY)
      );

      ctx.strokeStyle = '#312e81';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.floor(zone.x * scaleX) + 0.5,
        Math.floor(zone.y * scaleY) + 0.5,
        Math.ceil(zone.width * scaleX) - 1,
        Math.ceil(zone.height * scaleY) - 1
      );
    });
  }

  // 4. Draw Other Users
  (props.users || []).forEach((user) => {
    if (!user || !user.position) return;
    const isSelf = props.currentUser && user.socketId === props.currentUser.socketId;
    if (isSelf) return; // Draw self last on top

    const ux = (user.position.x + 0.5) * scaleX;
    const uy = (user.position.y + 0.5) * scaleY;

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(ux, uy, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = user.avatar?.outfitColor || '#3b82f6';
    ctx.beginPath();
    ctx.arc(ux, uy, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // 5. Draw Self (Current User) with Pulsing Radar Ring
  if (props.currentUser && props.currentUser.position) {
    const selfX = (props.currentUser.position.x + 0.5) * scaleX;
    const selfY = (props.currentUser.position.y + 0.5) * scaleY;

    // Radar proximity radius
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(selfX, selfY, 7 * scaleX, 0, Math.PI * 2);
    ctx.stroke();

    // Self dot border
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(selfX, selfY, 6, 0, Math.PI * 2);
    ctx.fill();

    // Self gold fill
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(selfX, selfY, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(selfX - 1, selfY - 1, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function handleCanvasClick(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;

  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const scaleX = canvas.width / props.currentMap.width;
  const scaleY = canvas.height / props.currentMap.height;

  const tileX = Math.floor(clickX / scaleX);
  const tileY = Math.floor(clickY / scaleY);

  if (tileX >= 0 && tileX < props.currentMap.width && tileY >= 0 && tileY < props.currentMap.height) {
    emit('navigateTile', { x: tileX, y: tileY });
  }
}

function handleCanvasMouseMove(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas || !props.currentMap) return;

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const scaleX = canvas.width / props.currentMap.width;
  const scaleY = canvas.height / props.currentMap.height;

  const tileX = Math.floor(mouseX / scaleX);
  const tileY = Math.floor(mouseY / scaleY);

  const found = props.users.find((u) => u.position.x === tileX && u.position.y === tileY);
  hoveredUser.value = found || null;
}

function handleCanvasMouseLeave() {
  hoveredUser.value = null;
}

onMounted(() => {
  renderMiniMap();
});

watch(
  [() => props.currentMap, () => props.users, () => props.currentUser, isExpanded, showZones],
  () => {
    renderMiniMap();
  },
  { deep: true }
);
</script>

<template>
  <div
    ref="minimapRef"
    class="hidden md:flex fixed bottom-24 left-4 z-30 flex-col items-start gap-1 select-none"
    :style="pos ? { position: 'fixed', left: `${pos.x}px`, top: `${pos.y}px`, bottom: 'auto', right: 'auto' } : {}"
  >
    <!-- Hovered User Tooltip Card -->
    <transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="hoveredUser"
        class="bg-slate-900 text-white border-2 border-slate-900 px-2.5 py-1 rounded-lg text-[10px] font-bold font-heading shadow-md flex items-center gap-1.5"
      >
        <span>{{ hoveredUser.avatar.statusEmoji || '👤' }}</span>
        <span>{{ hoveredUser.name }}</span>
        <span class="text-amber-400">({{ hoveredUser.position.x }}, {{ hoveredUser.position.y }})</span>
      </div>
    </transition>

    <!-- Main Minimap Card -->
    <div class="bg-white border-3 border-slate-900 rounded-2xl shadow-[5px_5px_0px_0px_#0f172a] p-2 flex flex-col gap-2">
      <!-- Header Bar & Drag Handle -->
      <div class="flex items-center justify-between gap-2 px-1">
        <div class="flex items-center gap-1 text-xs font-black text-slate-900 font-heading">
          <!-- Drag handle icon -->
          <button
            type="button"
            @mousedown="startDrag"
            @touchstart.passive="startDrag"
            class="p-0.5 text-slate-400 hover:text-slate-900 cursor-grab active:cursor-grabbing rounded hover:bg-slate-100 transition-colors"
            title="Click and drag to move minimap"
          >
            <GripVertical class="w-3.5 h-3.5" />
          </button>
          <Map class="w-3.5 h-3.5 text-amber-500" />
          <span class="truncate max-w-[95px]">{{ currentMap.name }}</span>
        </div>

        <div class="flex items-center gap-1">
          <!-- Reset position button (shown when dragged) -->
          <button
            v-if="pos"
            type="button"
            @click="resetPos"
            class="p-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-900 pixel-btn"
            title="Reset position to bottom-left"
          >
            <RotateCcw class="w-3 h-3" />
          </button>

          <!-- Toggle Zones Filter -->
          <button
            type="button"
            @click="showZones = !showZones"
            :class="`p-1 rounded border border-slate-900 text-[10px] font-bold transition-all pixel-btn ${
              showZones ? 'bg-indigo-100 text-indigo-950' : 'bg-slate-100 text-slate-400'
            }`"
            title="Toggle Private Zones Overlay"
          >
            <Lock class="w-3 h-3" />
          </button>

          <!-- Expand/Collapse Button -->
          <button
            type="button"
            @click="isExpanded = !isExpanded"
            class="p-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-900 pixel-btn"
            title="Resize Minimap"
          >
            <Minimize2 v-if="isExpanded" class="w-3 h-3" />
            <Maximize2 v-else class="w-3 h-3" />
          </button>
        </div>
      </div>

      <!-- Canvas Frame -->
      <div class="relative bg-slate-950 rounded-xl overflow-hidden border-2 border-slate-900 flex items-center justify-center p-1">
        <canvas
          ref="canvasRef"
          @click="handleCanvasClick"
          @mousemove="handleCanvasMouseMove"
          @mouseleave="handleCanvasMouseLeave"
          class="cursor-crosshair block rounded pixel-rendering"
        />

        <!-- Active Users Badge -->
        <div class="absolute bottom-1.5 left-1.5 bg-slate-900/80 backdrop-blur-sm text-white px-1.5 py-0.5 rounded text-[9px] font-extrabold flex items-center gap-1 border border-slate-700">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>{{ users.length }}</span>
        </div>
      </div>

      <!-- Controls Hint -->
      <div class="flex items-center justify-between text-[9px] font-bold text-slate-500 px-1 font-heading">
        <span class="flex items-center gap-1">
          <Compass class="w-3 h-3 text-amber-600" /> Click to walk
        </span>
        <span>{{ currentMap.width }}x{{ currentMap.height }}</span>
      </div>
    </div>
  </div>
</template>
