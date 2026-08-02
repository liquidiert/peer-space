<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { Camera, Mic, MicOff, Volume2, Maximize2, Minimize2, VideoOff, GripVertical } from 'lucide-vue-next';
import type { User } from '../types';

const props = defineProps<{
  currentUser: User;
  users: User[];
  isVideoOn: boolean;
  localVideoStream: MediaStream | null;
  remoteVideoStreams: Map<string, MediaStream>;
}>();

const emit = defineEmits<{
  (e: 'toggleCamera'): void;
}>();

const isCollapsed = ref(false);
const activeFocusSocketId = ref<string | null>(null);

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

// Active video users list
const activeVideoUsers = computed(() => {
  const list: { socketId: string; name: string; isLocal: boolean; stream: MediaStream; user?: User }[] = [];

  if (props.isVideoOn && props.localVideoStream) {
    list.push({
      socketId: props.currentUser.socketId,
      name: `${props.currentUser.name} (You)`,
      isLocal: true,
      stream: props.localVideoStream,
      user: props.currentUser,
    });
  }

  props.remoteVideoStreams.forEach((stream, socketId) => {
    const user = props.users.find((u) => u.socketId === socketId);
    list.push({
      socketId,
      name: user ? user.name : 'Peer',
      isLocal: false,
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

// Map of video element refs
const videoRefs = ref<Record<string, HTMLVideoElement | null>>({});

function setVideoRef(el: any, socketId: string, stream: MediaStream, isLocal: boolean) {
  if (el) {
    videoRefs.value[socketId] = el as HTMLVideoElement;
    bindVideo(el as HTMLVideoElement, stream, isLocal);
  }
}

watch(
  activeVideoUsers,
  (users) => {
    users.forEach((item) => {
      const el = videoRefs.value[item.socketId];
      if (el) {
        bindVideo(el, item.stream, item.isLocal);
      }
    });
  },
  { deep: true, immediate: true }
);
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
        :key="vUser.socketId"
        class="relative bg-slate-950 rounded-lg overflow-hidden border-2 border-slate-900 group shadow-sm"
      >
        <!-- Video Element -->
        <video
          :ref="(el) => setVideoRef(el, vUser.socketId, vUser.stream, vUser.isLocal)"
          autoplay
          playsinline
          :muted="vUser.isLocal"
          :class="`w-full object-cover aspect-video ${vUser.isLocal ? 'scale-x-[-1]' : ''}`"
        ></video>

        <!-- Overlay Info Bar -->
        <div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-slate-950/80 to-transparent p-2 flex items-center justify-between text-white text-xs">
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
</template>
