<script setup lang="ts">
import { computed } from 'vue';
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
import type { User, GridMap } from '../types';

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
}>();

const currentZone = computed(() => {
  return props.currentMap.privateZones.find((z) => z.id === props.currentUser.currentZoneId);
});

const myDesk = computed(() => {
  return props.currentMap.objects.find(
    (obj) => obj.type === 'desk' && obj.data?.deskState?.claimedByUserId === props.currentUser.id
  );
});
</script>

<template>
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 sm:gap-3 bg-white border-3 border-slate-900 px-3 sm:px-4 py-2 rounded-2xl shadow-[5px_5px_0px_0px_#0f172a] text-slate-900 max-w-[95vw] overflow-x-auto">
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
      title="Walk to Your Desk (G)"
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

    <!-- Avatar Builder -->
    <button
      type="button"
      @click="emit('openAvatarBuilder')"
      title="Customize Avatar (P)"
      class="h-10 px-3 sm:px-3.5 bg-indigo-100 hover:bg-indigo-200 border-2 border-slate-900 rounded-xl text-xs font-bold text-slate-900 inline-flex items-center justify-center gap-2 transition-colors pixel-btn shadow-[2px_2px_0px_0px_#0f172a]"
    >
      <Sparkles class="w-4 h-4 text-indigo-700 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">Avatar</span>
    </button>
  </div>
</template>
