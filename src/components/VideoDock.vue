<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { Camera, Mic, MicOff, Volume2, Maximize2, Minimize2, VideoOff, GripVertical, SwitchCamera, MonitorUp, Expand, X, LayoutGrid, Square, PanelRight, Search } from 'lucide-vue-next';
import type { User } from '../types';

const props = defineProps<{
  currentUser: User;
  users: User[];
  isVideoOn: boolean;
  localVideoStream: MediaStream | null;
  remoteVideoStreams: Map<string, MediaStream>;
  isScreenSharing?: boolean;
  localScreenStream?: MediaStream | null;
  remoteScreenStreams?: Map<string, MediaStream>;
  canSwitchCamera?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleCamera'): void;
  (e: 'switchCamera'): void;
}>();

const isCollapsed = ref(false);
const activeFocusKey = ref<string | null>(null);

/**
 * The stage (the fullscreen overlay) used to be able to show exactly one stream, which made
 * it useless for the common case of actually watching a call. It now has three layouts:
 * one big tile, an even grid of everyone, or a speaker plus a filmstrip of the rest.
 */
type StageLayout = 'spotlight' | 'grid' | 'sidebar';
const isStageOpen = ref(false);
const stageLayout = ref<StageLayout>('spotlight');

const STAGE_LAYOUTS: { id: StageLayout; label: string; icon: any }[] = [
  { id: 'spotlight', label: 'Spotlight', icon: Square },
  { id: 'grid', label: 'Grid', icon: LayoutGrid },
  { id: 'sidebar', label: 'Speaker + strip', icon: PanelRight },
];

// Dragging State
const dockRef = ref<HTMLElement | null>(null);
const position = ref<{ x: number; y: number } | null>(null);
const isDragging = ref(false);
let dragStartPos = { x: 0, y: 0 };
let dockStartPos = { x: 0, y: 0 };

function startDrag(e: MouseEvent | TouchEvent) {
  if (!dockRef.value) return;
  isDragging.value = true;
  const rect = dockRef.value.getBoundingClientRect();

  // Initialize position if not set
  if (!position.value) {
    position.value = { x: rect.left, y: rect.top };
  }

  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

  dragStartPos = { x: clientX, y: clientY };
  dockStartPos = { x: position.value.x, y: position.value.y };

  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('touchmove', onDrag);
  window.addEventListener('touchend', stopDrag);
}

function onDrag(e: MouseEvent | TouchEvent) {
  if (!isDragging.value || !dockRef.value) return;
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

  const dx = clientX - dragStartPos.x;
  const dy = clientY - dragStartPos.y;

  const rect = dockRef.value.getBoundingClientRect();
  const newX = Math.max(10, Math.min(window.innerWidth - rect.width - 10, dockStartPos.x + dx));
  const newY = Math.max(10, Math.min(window.innerHeight - rect.height - 10, dockStartPos.y + dy));

  position.value = { x: newX, y: newY };
}

function stopDrag() {
  isDragging.value = false;
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', stopDrag);
  window.removeEventListener('touchmove', onDrag);
  window.removeEventListener('touchend', stopDrag);
}

onUnmounted(() => {
  stopDrag();
  window.removeEventListener('keydown', onStageKeydown);
});

// Active video users list (camera feeds + screen shares)
const activeVideoUsers = computed(() => {
  const list: { key: string; socketId: string; name: string; isLocal: boolean; isScreen: boolean; stream: MediaStream; user?: User }[] = [];

  if (props.isVideoOn && props.localVideoStream) {
    list.push({
      key: `${props.currentUser.socketId}-camera`,
      socketId: props.currentUser.socketId,
      name: `${props.currentUser.name} (You)`,
      isLocal: true,
      isScreen: false,
      stream: props.localVideoStream,
      user: props.currentUser,
    });
  }

  props.remoteVideoStreams.forEach((stream, socketId) => {
    const user = props.users.find((u) => u.socketId === socketId);
    list.push({
      key: `${socketId}-camera`,
      socketId,
      name: user ? user.name : 'Peer',
      isLocal: false,
      isScreen: false,
      stream,
      user,
    });
  });

  if (props.isScreenSharing && props.localScreenStream) {
    list.push({
      key: `${props.currentUser.socketId}-screen`,
      socketId: props.currentUser.socketId,
      name: `${props.currentUser.name} (Your Screen)`,
      isLocal: true,
      isScreen: true,
      stream: props.localScreenStream,
      user: props.currentUser,
    });
  }

  props.remoteScreenStreams?.forEach((stream, socketId) => {
    const user = props.users.find((u) => u.socketId === socketId);
    list.push({
      key: `${socketId}-screen`,
      socketId,
      name: `${user ? user.name : 'Peer'} (Screen)`,
      isLocal: false,
      isScreen: true,
      stream,
      user,
    });
  });

  return list;
});

// Helper component / directive to bind MediaStream to <video> element safely
function bindVideo(el: HTMLVideoElement | null, stream: MediaStream | null, isMuted: boolean) {
  if (el) {
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.muted = isMuted;
    if (stream) {
      el.play().catch((e) => console.warn('Video play error:', e));
    }
  }
}

// Map of video element refs, keyed by the tile's unique key (socketId + camera/screen)
const videoRefs = ref<Record<string, HTMLVideoElement | null>>({});

function setVideoRef(el: any, key: string, stream: MediaStream, isLocal: boolean) {
  if (el) {
    videoRefs.value[key] = el as HTMLVideoElement;
    bindVideo(el as HTMLVideoElement, stream, isLocal);
  }
}

watch(
  activeVideoUsers,
  (users) => {
    users.forEach((item) => {
      const el = videoRefs.value[item.key];
      if (el) {
        bindVideo(el, item.stream, item.isLocal);
      }
    });

    // If the maximized tile's stream went away (camera/screen share stopped, peer left), close it
    if (activeFocusKey.value && !users.some((u) => u.key === activeFocusKey.value)) {
      activeFocusKey.value = null;
    }
  },
  { deep: true, immediate: true }
);

// ==========================================
// STAGE (fullscreen overlay)
// ==========================================

type VideoTile = (typeof activeVideoUsers)['value'][number];

/** Falls back to the first stream so the stage is never blank after its subject leaves. */
const focusedVideo = computed<VideoTile | null>(
  () => activeVideoUsers.value.find((u) => u.key === activeFocusKey.value) ?? activeVideoUsers.value[0] ?? null
);

/** Everything the current layout puts on the big surface. */
const stageMainTiles = computed<VideoTile[]>(() => {
  if (stageLayout.value === 'grid') return activeVideoUsers.value;
  return focusedVideo.value ? [focusedVideo.value] : [];
});

/** The filmstrip beside the speaker - only the sidebar layout has one. */
const stageStripTiles = computed<VideoTile[]>(() => {
  if (stageLayout.value !== 'sidebar') return [];
  return activeVideoUsers.value.filter((u) => u.key !== focusedVideo.value?.key);
});

/** Keeps grid tiles roughly square-ish as the call grows instead of stretching to a strip. */
const stageGridColumns = computed(() => {
  const n = stageMainTiles.value.length;
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
});

const stageVideoRefs = ref<Record<string, HTMLVideoElement | null>>({});

function setStageVideoRef(el: any, item: VideoTile) {
  stageVideoRefs.value[item.key] = (el as HTMLVideoElement) || null;
  if (el) bindVideo(el as HTMLVideoElement, item.stream, item.isLocal);
}

// The same stream can be mounted in the dock and on the stage at once, so the stage needs
// its own rebind pass whenever the stream behind a key is swapped out.
watch(
  [activeVideoUsers, stageLayout],
  () => {
    activeVideoUsers.value.forEach((item) => {
      const el = stageVideoRefs.value[item.key];
      if (el) bindVideo(el, item.stream, item.isLocal);
    });
    if (activeVideoUsers.value.length === 0) isStageOpen.value = false;

    // A stream that ended must not leave its zoom behind for whoever reuses the key.
    Object.keys(zoomStates.value).forEach((key) => {
      if (!activeVideoUsers.value.some((u) => u.key === key)) resetZoom(key);
    });
  },
  { deep: true }
);

function openStage(key: string | null, layout: StageLayout = 'spotlight') {
  if (key) activeFocusKey.value = key;
  stageLayout.value = layout;
  isStageOpen.value = true;
}

function closeStage() {
  isStageOpen.value = false;
}

/** Clicking a strip tile promotes it, which is the whole point of having the strip. */
function focusStageTile(key: string) {
  activeFocusKey.value = key;
  if (stageLayout.value === 'grid') stageLayout.value = 'spotlight';
}

// ==========================================
// SCREEN SHARE ZOOM
// ==========================================
// Shared screens are usually someone's whole desktop scaled into a tile, which makes code,
// terminals and spreadsheets unreadable. Screen tiles on the stage can therefore be zoomed
// with the wheel and panned by dragging - camera tiles are left alone, since there is
// nothing in a webcam feed worth magnifying.

type ZoomState = { scale: number; x: number; y: number };
const MAX_ZOOM = 8;
const zoomStates = ref<Record<string, ZoomState>>({});

function getZoom(key: string): ZoomState {
  return zoomStates.value[key] ?? { scale: 1, x: 0, y: 0 };
}

function isZoomed(key: string): boolean {
  return getZoom(key).scale > 1;
}

/** Panning further than this would just drag the picture off its own tile. */
function clampPan(state: ZoomState, el: HTMLElement): ZoomState {
  const maxX = (el.clientWidth * (state.scale - 1)) / 2;
  const maxY = (el.clientHeight * (state.scale - 1)) / 2;
  return {
    scale: state.scale,
    x: Math.max(-maxX, Math.min(maxX, state.x)),
    y: Math.max(-maxY, Math.min(maxY, state.y)),
  };
}

function setZoom(key: string, state: ZoomState, el: HTMLElement) {
  if (state.scale <= 1) {
    const next = { ...zoomStates.value };
    delete next[key];
    zoomStates.value = next;
    return;
  }
  zoomStates.value = { ...zoomStates.value, [key]: clampPan(state, el) };
}

function resetZoom(key: string) {
  const next = { ...zoomStates.value };
  delete next[key];
  zoomStates.value = next;
}

function onZoomWheel(e: WheelEvent, item: VideoTile) {
  if (!item.isScreen) return;
  e.preventDefault();

  const el = e.currentTarget as HTMLElement;
  const current = getZoom(item.key);
  const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  const scale = Math.max(1, Math.min(MAX_ZOOM, current.scale * factor));

  // Keep whatever is under the cursor under the cursor, so zooming feels like leaning in
  // towards that part of the screen rather than towards the middle of the tile.
  const rect = el.getBoundingClientRect();
  const cursorX = e.clientX - rect.left - rect.width / 2;
  const cursorY = e.clientY - rect.top - rect.height / 2;
  const ratio = scale / current.scale;

  setZoom(
    item.key,
    {
      scale,
      x: cursorX - (cursorX - current.x) * ratio,
      y: cursorY - (cursorY - current.y) * ratio,
    },
    el
  );
}

// Pan state lives outside the reactive map - it changes on every pointermove.
let panKey: string | null = null;
let panEl: HTMLElement | null = null;
let panStart = { x: 0, y: 0, offsetX: 0, offsetY: 0 };

function startZoomPan(e: PointerEvent, item: VideoTile) {
  if (!item.isScreen || !isZoomed(item.key)) return;
  e.preventDefault();
  const current = getZoom(item.key);
  panKey = item.key;
  panEl = e.currentTarget as HTMLElement;
  panStart = { x: e.clientX, y: e.clientY, offsetX: current.x, offsetY: current.y };
  try {
    panEl.setPointerCapture(e.pointerId);
  } catch (_) {}
}

function onZoomPan(e: PointerEvent) {
  if (!panKey || !panEl) return;
  const current = getZoom(panKey);
  setZoom(
    panKey,
    {
      scale: current.scale,
      x: panStart.offsetX + (e.clientX - panStart.x),
      y: panStart.offsetY + (e.clientY - panStart.y),
    },
    panEl
  );
}

function stopZoomPan() {
  panKey = null;
  panEl = null;
}

function zoomTransform(item: VideoTile): string | undefined {
  if (!item.isScreen) return undefined;
  const { scale, x, y } = getZoom(item.key);
  if (scale === 1) return undefined;
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

function onStageKeydown(e: KeyboardEvent) {
  if (!isStageOpen.value) return;
  if (e.key === 'Escape') {
    // Backing out of a zoom is the more likely intent than closing the whole stage.
    if (focusedVideo.value && isZoomed(focusedVideo.value.key)) resetZoom(focusedVideo.value.key);
    else closeStage();
  } else if (e.key.toLowerCase() === 'g') {
    stageLayout.value = stageLayout.value === 'grid' ? 'spotlight' : 'grid';
  }
}

onMounted(() => {
  window.addEventListener('keydown', onStageKeydown);
});
</script>

<template>
  <div
    v-if="activeVideoUsers.length > 0"
    ref="dockRef"
    :class="`fixed z-40 flex flex-col items-end max-w-[90vw] sm:max-w-xs md:max-w-sm ${
      position ? '' : 'top-16 right-4'
    }`"
    :style="position ? { left: `${position.x}px`, top: `${position.y}px` } : {}"
  >
    <!-- Header Bar (Draggable) -->
    <div
      @mousedown="startDrag"
      @touchstart="startDrag"
      class="bg-slate-900 text-white border-2 border-slate-900 px-3 py-1.5 rounded-t-xl flex items-center justify-between w-full shadow-[3px_3px_0px_0px_#0f172a] cursor-grab active:cursor-grabbing select-none"
    >
      <div class="flex items-center gap-2 text-xs font-heading font-bold">
        <GripVertical class="w-3.5 h-3.5 text-slate-400" />
        <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
        <span>WebRTC Video Feed ({{ activeVideoUsers.length }})</span>
      </div>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          @click.stop="openStage(null, 'grid')"
          class="hidden md:block text-slate-300 hover:text-white p-0.5 rounded transition-colors"
          title="Open all streams (G)"
        >
          <LayoutGrid class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          @click.stop="isCollapsed = !isCollapsed"
          class="text-slate-300 hover:text-white p-0.5 rounded transition-colors"
          title="Toggle Dock"
        >
          <Minimize2 v-if="!isCollapsed" class="w-3.5 h-3.5" />
          <Maximize2 v-else class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- Video Grid Body -->
    <div
      v-show="!isCollapsed"
      class="bg-white/95 backdrop-blur-sm border-2 border-slate-900 border-t-0 p-2 rounded-b-xl shadow-[4px_4px_0px_0px_#0f172a] w-full flex flex-col gap-2 max-h-[60vh] overflow-y-auto"
    >
      <div
        v-for="vUser in activeVideoUsers"
        :key="vUser.key"
        class="relative bg-slate-950 rounded-lg overflow-hidden border-2 border-slate-900 group shadow-sm"
      >
        <!-- Video Element -->
        <video
          :ref="(el) => setVideoRef(el, vUser.key, vUser.stream, vUser.isLocal)"
          autoplay
          playsinline
          :muted="vUser.isLocal"
          :class="`w-full object-cover aspect-video ${vUser.isLocal && !vUser.isScreen ? 'scale-x-[-1]' : ''}`"
        ></video>

        <!-- Top-right tile controls -->
        <div class="absolute top-1.5 right-1.5 flex items-center gap-1">
          <!-- Maximize (desktop only) -->
          <button
            type="button"
            @click.stop="openStage(vUser.key, 'spotlight')"
            title="Maximize"
            class="hidden md:flex p-1.5 rounded-lg bg-slate-900/70 hover:bg-slate-900/90 text-white border border-white/20 transition-colors"
          >
            <Expand class="w-3.5 h-3.5" />
          </button>

          <!-- Switch Camera Button (local camera tile only) -->
          <button
            v-if="vUser.isLocal && !vUser.isScreen && canSwitchCamera"
            type="button"
            @click.stop="emit('switchCamera')"
            title="Switch Camera (Shift+V)"
            class="p-1.5 rounded-lg bg-slate-900/70 hover:bg-slate-900/90 text-white border border-white/20 transition-colors"
          >
            <SwitchCamera class="w-3.5 h-3.5" />
          </button>
        </div>

        <!-- Screen Share Badge -->
        <span
          v-if="vUser.isScreen"
          class="absolute top-1.5 left-1.5 p-1 rounded-lg bg-indigo-600/80 text-white border border-white/20"
          title="Screen Share"
        >
          <MonitorUp class="w-3.5 h-3.5" />
        </span>

        <!-- Overlay Info Bar -->
        <div class="absolute bottom-0 inset-x-0 bg-linear-to-t from-slate-950/80 to-transparent p-2 flex items-center justify-between text-white text-xs">
          <div class="flex items-center gap-1.5 font-bold truncate max-w-[70%]">
            <span class="truncate font-heading">{{ vUser.name }}</span>
          </div>

          <div class="flex items-center gap-1">
            <span
              v-if="vUser.user?.isMuted"
              class="p-1 rounded bg-rose-500/80 text-white"
              title="Muted"
            >
              <MicOff class="w-3 h-3" />
            </span>
            <span
              v-else-if="vUser.user?.isSpeaking"
              class="p-1 rounded bg-emerald-500/80 text-white animate-bounce"
              title="Speaking"
            >
              <Mic class="w-3 h-3" />
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Stage: fullscreen overlay with selectable layouts (desktop only) -->
  <div
    v-if="isStageOpen && focusedVideo"
    class="hidden md:flex fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex-col p-6 gap-4"
    @click.self="closeStage"
  >
    <!-- Stage toolbar -->
    <div class="shrink-0 flex items-center justify-between gap-3">
      <div class="bg-slate-900/80 text-white px-3 py-1.5 rounded-xl text-sm font-bold font-heading flex items-center gap-2 min-w-0">
        <MonitorUp v-if="stageLayout !== 'grid' && focusedVideo.isScreen" class="w-4 h-4 shrink-0" />
        <span class="truncate">
          {{ stageLayout === 'grid' ? `All streams (${activeVideoUsers.length})` : focusedVideo.name }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1 p-1 bg-slate-900/80 rounded-xl border-2 border-white/15">
          <button
            v-for="l in STAGE_LAYOUTS"
            :key="l.id"
            type="button"
            @click.stop="stageLayout = l.id"
            :title="l.label"
            :class="`p-1.5 rounded-lg transition-colors ${
              stageLayout === l.id ? 'bg-amber-400 text-slate-950' : 'text-slate-300 hover:text-white hover:bg-white/10'
            }`"
          >
            <component :is="l.icon" class="w-4 h-4" />
          </button>
        </div>

        <button
          type="button"
          @click.stop="closeStage"
          title="Close (Esc)"
          class="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-900 text-white border-2 border-white/20 transition-colors"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Stage body -->
    <div class="flex-1 min-h-0 flex gap-4">
      <div
        class="flex-1 min-w-0 grid gap-3 content-center"
        :style="{ gridTemplateColumns: `repeat(${stageGridColumns}, minmax(0, 1fr))` }"
      >
        <div
          v-for="item in stageMainTiles"
          :key="`stage-${item.key}`"
          @click.stop="stageLayout === 'grid' ? focusStageTile(item.key) : null"
          @wheel="onZoomWheel($event, item)"
          @pointerdown="startZoomPan($event, item)"
          @pointermove="onZoomPan"
          @pointerup="stopZoomPan"
          @pointercancel="stopZoomPan"
          @dblclick.stop="item.isScreen ? resetZoom(item.key) : null"
          :class="`relative bg-slate-950 rounded-2xl overflow-hidden border-3 border-slate-900 shadow-[6px_6px_0px_0px_#020617] min-h-0 ${
            isZoomed(item.key) ? 'cursor-grab active:cursor-grabbing touch-none' : stageLayout === 'grid' ? 'cursor-zoom-in' : ''
          }`"
        >
          <video
            :ref="(el) => setStageVideoRef(el, item)"
            autoplay
            playsinline
            :muted="item.isLocal"
            :style="{ transform: zoomTransform(item) }"
            :class="`w-full h-full object-contain bg-slate-950 ${
              stageLayout === 'grid' ? 'aspect-video' : 'max-h-[78vh]'
            } ${item.isLocal && !item.isScreen ? 'scale-x-[-1]' : ''}`"
          ></video>

          <!-- Zoom affordances - screen shares only -->
          <div v-if="item.isScreen" class="absolute top-2 right-2 flex items-center gap-1.5">
            <span
              v-if="isZoomed(item.key)"
              class="px-2 py-1 rounded-lg bg-slate-900/80 text-white text-[10px] font-extrabold font-heading border border-white/20"
            >
              {{ getZoom(item.key).scale.toFixed(1) }}x
            </span>
            <button
              v-if="isZoomed(item.key)"
              type="button"
              @click.stop="resetZoom(item.key)"
              title="Reset zoom (double-click / Esc)"
              class="p-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-900 text-white border border-white/20 transition-colors"
            >
              <X class="w-3.5 h-3.5" />
            </button>
            <span
              v-else
              class="px-2 py-1 rounded-lg bg-slate-900/70 text-slate-200 text-[10px] font-bold font-heading border border-white/15 flex items-center gap-1"
            >
              <Search class="w-3 h-3" /> Scroll to zoom
            </span>
          </div>

          <div class="absolute bottom-0 inset-x-0 bg-linear-to-t from-slate-950/80 to-transparent p-2.5 flex items-center justify-between text-white text-xs">
            <span class="truncate font-heading font-bold flex items-center gap-1.5">
              <MonitorUp v-if="item.isScreen" class="w-3.5 h-3.5 shrink-0" />
              {{ item.name }}
            </span>
            <span
              v-if="item.user?.isMuted"
              class="p-1 rounded bg-rose-500/80"
              title="Muted"
            >
              <MicOff class="w-3 h-3" />
            </span>
            <span
              v-else-if="item.user?.isSpeaking"
              class="p-1 rounded bg-emerald-500/80 animate-bounce"
              title="Speaking"
            >
              <Mic class="w-3 h-3" />
            </span>
          </div>
        </div>
      </div>

      <!-- Filmstrip (sidebar layout) - click any tile to promote it to the speaker slot -->
      <div
        v-if="stageStripTiles.length > 0"
        class="shrink-0 w-56 flex flex-col gap-2 overflow-y-auto custom-scrollbar pr-1"
      >
        <div
          v-for="item in stageStripTiles"
          :key="`strip-${item.key}`"
          @click.stop="focusStageTile(item.key)"
          class="relative bg-slate-950 rounded-xl overflow-hidden border-2 border-slate-900 shadow-[3px_3px_0px_0px_#020617] cursor-zoom-in hover:border-amber-400 transition-colors"
        >
          <video
            :ref="(el) => setStageVideoRef(el, item)"
            autoplay
            playsinline
            :muted="item.isLocal"
            :class="`w-full object-cover aspect-video ${item.isLocal && !item.isScreen ? 'scale-x-[-1]' : ''}`"
          ></video>
          <div class="absolute bottom-0 inset-x-0 bg-linear-to-t from-slate-950/80 to-transparent px-2 py-1 text-white text-[10px] font-bold font-heading truncate">
            {{ item.name }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
