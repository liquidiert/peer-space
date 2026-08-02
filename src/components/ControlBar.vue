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
}>();

const emit = defineEmits<{
  (e: 'toggleMute'): void;
  (e: 'toggleDeafen'): void;
  (e: 'toggleCamera'): void;
  (e: 'toggleScreenShare'): void;
  (e: 'toggleBuilderMode'): void;
  (e: 'openAvatarBuilder'): void;
}>();

const currentZone = computed(() => {
  return props.currentMap.privateZones.find((z) => z.id === props.currentUser.currentZoneId);
});
</script>

<template>
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 sm:gap-3 bg-white border-3 border-slate-900 px-3 sm:px-4 py-2 rounded-2xl shadow-[5px_5px_0px_0px_#0f172a] text-slate-900 max-w-[95vw] overflow-x-auto">
    <!-- Zone Badge -->
    <div class="hidden lg:flex items-center gap-1.5 h-10 px-3 rounded-xl bg-amber-100 border-2 border-slate-900 text-xs font-bold text-slate-900 shadow-[2px_2px_0px_0px_#0f172a]">
      <MapPin class="w-4 h-4 text-indigo-600 shrink-0" />
      <span v-if="currentZone" class="text-amber-900 font-extrabold tracking-wide font-heading truncate max-w-[140px]">{{ currentZone.name }}</span>
      <span v-else class="font-heading">Main Floor</span>
    </div>

    <div class="h-6 w-0.5 bg-slate-900 hidden lg:block" />

    <!-- Mic Control -->
    <button
      type="button"
      @click="emit('toggleMute')"
      :title="isMuted ? 'Unmute Microphone' : 'Mute Microphone'"
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
      :title="isDeafened ? 'Undeafen Audio' : 'Deafen Audio'"
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
      :title="isVideoOn ? 'Turn Off Video' : 'Turn On Video'"
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

    <!-- Screen Share -->
    <button
      type="button"
      @click="emit('toggleScreenShare')"
      :title="isScreenSharing ? 'Stop Screen Share' : 'Start Screen Share'"
      :class="`h-10 px-3 sm:px-3.5 rounded-xl border-2 border-slate-900 inline-flex items-center justify-center gap-2 text-xs font-bold transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] ${
        isScreenSharing
          ? 'bg-indigo-500 text-white hover:bg-indigo-600'
          : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
      }`"
    >
      <Monitor class="w-4 h-4 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">{{ isScreenSharing ? 'Sharing' : 'Screen' }}</span>
    </button>

    <!-- Avatar Builder -->
    <button
      type="button"
      @click="emit('openAvatarBuilder')"
      title="Customize Avatar"
      class="h-10 px-3 sm:px-3.5 bg-indigo-100 hover:bg-indigo-200 border-2 border-slate-900 rounded-xl text-xs font-bold text-slate-900 inline-flex items-center justify-center gap-2 transition-colors pixel-btn shadow-[2px_2px_0px_0px_#0f172a]"
    >
      <Sparkles class="w-4 h-4 text-indigo-700 shrink-0" />
      <span class="hidden sm:inline font-heading whitespace-nowrap">Avatar</span>
    </button>
  </div>
</template>
