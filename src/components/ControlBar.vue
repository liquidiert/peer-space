<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Video,
  VideoOff,
  Monitor,
  Sparkles,
  MapPin,
  MessageCircle,
  Armchair,
} from 'lucide-vue-next';
import type { User, GridMap, PresenceStatus } from '../types';

const props = defineProps<{
  isMuted: boolean;
  isDeafened: boolean;
  isVideoOn?: boolean;
  isScreenSharing: boolean;
  builderMode: boolean;
  currentUser: User;
  currentMap: GridMap;
  isChatOpen: boolean;
  unreadChatCount?: number;
}>();

const emit = defineEmits<{
  (e: 'toggleMute'): void;
  (e: 'toggleDeafen'): void;
  (e: 'toggleCamera'): void;
  (e: 'toggleScreenShare'): void;
  (e: 'toggleBuilderMode'): void;
  (e: 'openAvatarBuilder'): void;
  (e: 'toggleChat'): void;
  (e: 'moveToDesk'): void;
  (e: 'setPresenceStatus', status: PresenceStatus): void;
  (e: 'placeDummy'): void;
}>();

const currentZone = computed(() => {
  return props.currentMap.privateZones.find((z) => z.id === props.currentUser.currentZoneId);
});

const PRESENCE_META: Record<
  PresenceStatus,
  { label: string; shortLabel: string; dot: string; hint: string }
> = {
  available: {
    label: 'Available',
    shortLabel: 'AVAIL',
    dot: 'bg-emerald-500',
    hint: 'Open to conversation',
  },
  busy: {
    label: 'Busy',
    shortLabel: 'BUSY',
    dot: 'bg-amber-500',
    hint: 'Heads down, but reachable',
  },
  dnd: {
    label: 'Do Not Disturb',
    shortLabel: 'DND',
    dot: 'bg-rose-500',
    hint: 'Please do not interrupt',
  },
};
const PRESENCE_OPTIONS: PresenceStatus[] = ['available', 'busy', 'dnd'];

// Picking a state directly instead of cycling: with three states, setting the one you want
// took up to three clicks and briefly broadcast the states you were passing through.
const presenceMenuOpen = ref(false);

function choosePresence(status: PresenceStatus) {
  presenceMenuOpen.value = false;
  if (status !== props.currentUser.presenceStatus) emit('setPresenceStatus', status);
}

function closePresenceMenu(e: MouseEvent) {
  if (!(e.target as HTMLElement)?.closest('[data-presence-menu]')) presenceMenuOpen.value = false;
}
window.addEventListener('click', closePresenceMenu);
onUnmounted(() => window.removeEventListener('click', closePresenceMenu));

const presenceMeta = computed(() => PRESENCE_META[props.currentUser.presenceStatus] || PRESENCE_META.available);

const myDesk = computed(() => {
  return props.currentMap.objects.find(
    (obj) => obj.type === 'desk' && obj.data?.deskState?.claimedByUserId === props.currentUser.id
  );
});
</script>

<template>
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 sm:gap-3 bg-white border-3 border-slate-900 px-3 sm:px-4 py-2 rounded-2xl shadow-[5px_5px_0px_0px_#0f172a] text-slate-900 max-w-[95vw]">
    <!-- Zone Badge -->
    <div class="hidden lg:flex items-center gap-1.5 h-10 px-3 rounded-xl bg-amber-100 border-2 border-slate-900 text-xs font-bold text-slate-900 shadow-[2px_2px_0px_0px_#0f172a]">
      <MapPin class="w-4 h-4 text-indigo-600 shrink-0" />
      <span v-if="currentZone" class="text-amber-900 font-extrabold tracking-wide font-heading truncate max-w-35">{{ currentZone.name }}</span>
      <span v-else class="font-heading">Main Floor</span>
    </div>

    <!-- Move to Claimed Desk -->
    <button
      v-if="myDesk"
      type="button"
      @click="emit('moveToDesk')"
      title="Walk to Your Desk"
      class="h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] bg-amber-300 text-slate-950 hover:bg-amber-200"
    >
      <Armchair class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">My Desk</span>
    </button>

    <div class="h-6 w-0.5 bg-slate-900 hidden lg:block" />

    <!-- Mic Control -->
    <button
      type="button"
      @click="emit('toggleMute')"
      :title="isMuted ? 'Unmute Microphone (M)' : 'Mute Microphone (M)'"
      :class="`h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
        isMuted
          ? 'bg-rose-400 text-slate-950 hover:bg-rose-300'
          : 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
      }`"
    >
      <MicOff v-if="isMuted" class="w-4 h-4 shrink-0" />
      <Mic v-else class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">{{ isMuted ? 'Muted' : 'Mic On' }}</span>
    </button>

    <!-- Deafen Control -->
    <button
      type="button"
      @click="emit('toggleDeafen')"
      :title="isDeafened ? 'Undeafen Audio (N)' : 'Deafen Audio (N)'"
      :class="`h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
        isDeafened
          ? 'bg-rose-400 text-slate-950 hover:bg-rose-300'
          : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
      }`"
    >
      <VolumeX v-if="isDeafened" class="w-4 h-4 shrink-0" />
      <Volume2 v-else class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">{{ isDeafened ? 'Deafened' : 'Sound' }}</span>
    </button>

    <!-- Camera Control -->
    <button
      type="button"
      @click="emit('toggleCamera')"
      :title="isVideoOn ? 'Turn Off Video (V)' : 'Turn On Video (V)'"
      :class="`h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
        isVideoOn
          ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
          : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
      }`"
    >
      <VideoOff v-if="!isVideoOn" class="w-4 h-4 shrink-0" />
      <Video v-else class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">{{ isVideoOn ? 'Video On' : 'Camera' }}</span>
    </button>

    <!-- Screen Share (desktop only - getDisplayMedia isn't reliably supported on mobile browsers) -->
    <button
      type="button"
      @click="emit('toggleScreenShare')"
      :title="isScreenSharing ? 'Stop Screen Share (B)' : 'Start Screen Share (B)'"
      :class="`hidden md:inline-flex h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
        isScreenSharing
          ? 'bg-indigo-500 text-white hover:bg-indigo-600'
          : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
      }`"
    >
      <Monitor class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">{{ isScreenSharing ? 'Sharing' : 'Screen' }}</span>
    </button>

    <!-- Chat & People -->
    <button
      type="button"
      @click="emit('toggleChat')"
      :title="isChatOpen ? 'Close Chat (C)' : 'Open Chat & People (C)'"
      :class="`relative h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
        isChatOpen
          ? 'bg-indigo-500 text-white hover:bg-indigo-600'
          : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
      }`"
    >
      <MessageCircle class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">Chat</span>
      <span
        v-if="!isChatOpen && (unreadChatCount ?? 0) > 0"
        class="absolute -top-1.5 -right-1.5 bg-rose-500 text-white font-black text-[9px] min-w-4 h-4 px-1 rounded-full flex items-center justify-center border border-slate-900"
      >
        {{ unreadChatCount }}
      </span>
    </button>

    <!-- Presence Status: opens a picker so any state is one click away -->
    <div class="relative" data-presence-menu>
      <button
        type="button"
        @click="presenceMenuOpen = !presenceMenuOpen"
        :title="`Status: ${presenceMeta.label}`"
        :class="`h-10 px-3 sm:px-3.5 sm:w-22 border-2 border-slate-900 rounded-xl text-xs font-bold text-slate-900 inline-flex items-center justify-center gap-2 transition-colors pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
          presenceMenuOpen ? 'bg-amber-300' : 'bg-slate-100 hover:bg-slate-200'
        }`"
      >
        <span :class="`w-3 h-3 rounded-full border-2 border-slate-900 shrink-0 ${presenceMeta.dot}`" />
        <span class="hidden sm:inline-block font-heading whitespace-nowrap w-10 text-left">{{ presenceMeta.shortLabel }}</span>
      </button>

      <div
        v-if="presenceMenuOpen"
        class="absolute bottom-full right-0 mb-2 w-56 bg-white border-3 border-slate-900 rounded-2xl shadow-[5px_5px_0px_0px_#0f172a] p-1.5 flex flex-col gap-1 z-50"
      >
        <button
          v-for="opt in PRESENCE_OPTIONS"
          :key="opt"
          type="button"
          @click="choosePresence(opt)"
          :class="`w-full text-left px-2.5 py-2 rounded-xl border-2 flex items-center gap-2.5 transition-colors ${
            currentUser.presenceStatus === opt
              ? 'bg-amber-200 border-slate-900'
              : 'bg-white border-transparent hover:bg-slate-100'
          }`"
        >
          <span :class="`w-3 h-3 rounded-full border-2 border-slate-900 shrink-0 ${PRESENCE_META[opt].dot}`" />
          <span class="min-w-0">
            <span class="block text-xs font-extrabold text-slate-900 font-heading">{{ PRESENCE_META[opt].label }}</span>
            <span class="block text-[10px] font-bold text-slate-600">{{ PRESENCE_META[opt].hint }}</span>
          </span>
        </button>
      </div>
      </div>
  <!-- Dummy User Placement (Admin only) -->
  <button
    v-if="currentUser.isAdmin"
    type="button"
    @click="emit('placeDummy')"
    title="Place a test user at your location (Admin)"
    :class="`h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] bg-purple-100 text-purple-950 hover:bg-purple-200`"
  >
    <UserRoundCog class="w-4 h-4 shrink-0" />
    <span class="hidden sm:inline font-heading whitespace-nowrap">Test User</span>
  </button>
</div>
</template>
