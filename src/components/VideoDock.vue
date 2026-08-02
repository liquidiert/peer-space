<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { Camera, Mic, MicOff, Volume2, Maximize2, Minimize2, VideoOff, GripVertical, SwitchCamera, MonitorUp, Expand, X } from 'lucide-vue-next';
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

// Maximized (desktop) video overlay
const focusedVideo = computed(() => activeVideoUsers.value.find((u) => u.key === activeFocusKey.value) ?? null);
const focusedVideoRef = ref<HTMLVideoElement | null>(null);

watch(focusedVideo, (item) => {
  if (item && focusedVideoRef.value) {
    bindVideo(focusedVideoRef.value, item.stream, item.isLocal);
  }
});

function setFocusedVideoRef(el: any) {
  focusedVideoRef.value = el as HTMLVideoElement | null;
  if (focusedVideo.value) {
    bindVideo(focusedVideoRef.value, focusedVideo.value.stream, focusedVideo.value.isLocal);
  }
}
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
            @click.stop="activeFocusKey = vUser.key"
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

  <!-- Maximized Video Overlay (desktop only) -->
  <div
    v-if="focusedVideo"
    class="hidden md:flex fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm items-center justify-center p-8"
    @click.self="activeFocusKey = null"
  >
    <div class="relative max-w-5xl w-full">
      <video
        :ref="setFocusedVideoRef"
        autoplay
        playsinline
        :muted="focusedVideo.isLocal"
        :class="`w-full max-h-[80vh] object-contain rounded-2xl border-3 border-slate-900 shadow-[8px_8px_0px_0px_#020617] ${focusedVideo.isLocal && !focusedVideo.isScreen ? 'scale-x-[-1]' : ''}`"
      ></video>

      <div class="absolute top-3 left-3 bg-slate-900/80 text-white px-3 py-1.5 rounded-xl text-sm font-bold font-heading flex items-center gap-2">
        <MonitorUp v-if="focusedVideo.isScreen" class="w-4 h-4" />
        <span>{{ focusedVideo.name }}</span>
      </div>

      <button
        type="button"
        @click="activeFocusKey = null"
        title="Close"
        class="absolute top-3 right-3 p-2 rounded-xl bg-slate-900/80 hover:bg-slate-900 text-white border-2 border-white/20 transition-colors"
      >
        <X class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>
