<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import {
  MessageSquare,
  Users,
  Radio,
  Send,
  Compass,
  Mic,
  MicOff,
  ChevronDown,
  MessageCircle,
} from 'lucide-vue-next';
import type { User, ChatMessage } from '../types';

const props = defineProps<{
  currentUser: User;
  users: User[];
  messages: ChatMessage[];
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'sendMessage', payload: { text: string; isSpatial: boolean }): void;
  (e: 'teleportToUser', payload: { x: number; y: number }): void;
  (e: 'close'): void;
}>();

const activeTab = ref<'spatial' | 'global' | 'users'>('spatial');
const inputText = ref('');
const messagesContainerRef = ref<HTMLDivElement | null>(null);

watch(
  () => props.isOpen,
  (open) => {
    if (open) scrollToBottom();
  }
);

function getDistance(otherUser: User): number {
  if (!props.currentUser || !otherUser) return 0;
  return Math.round(
    Math.hypot(
      props.currentUser.position.x - otherUser.position.x,
      props.currentUser.position.y - otherUser.position.y
    )
  );
}

function getAudioVolume(otherUser: User): number {
  if (!props.currentUser || !otherUser) return 0;
  if (props.currentUser.isDeafened || otherUser.isMuted) return 0;

  const myZone = props.currentUser.currentZoneId;
  const targetZone = otherUser.currentZoneId;

  if (myZone && targetZone) {
    return myZone === targetZone ? 100 : 0;
  } else if (myZone || targetZone) {
    return 0;
  }

  const dist = Math.hypot(
    props.currentUser.position.x - otherUser.position.x,
    props.currentUser.position.y - otherUser.position.y
  );
  if (dist > 8) return 0;
  return Math.round((1 - dist / 8) * 100);
}

const filteredMessages = computed(() => {
  if (activeTab.value === 'spatial') {
    return props.messages.filter((m) => m.isSpatial);
  }
  return props.messages.filter((m) => !m.isSpatial);
});

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainerRef.value) {
      messagesContainerRef.value.scrollTop = messagesContainerRef.value.scrollHeight;
    }
  });
}

watch(filteredMessages, () => {
  scrollToBottom();
});

function handleSend() {
  if (!inputText.value.trim()) return;
  emit('sendMessage', {
    text: inputText.value.trim(),
    isSpatial: activeTab.value === 'spatial',
  });
  inputText.value = '';
}
</script>

<template>
  <div
    v-if="isOpen"
    class="fixed z-40 bottom-20 left-1/2 -translate-x-1/2 w-[92vw] sm:w-88 sm:left-auto sm:right-4 sm:translate-x-0 h-96 bg-white border-3 border-slate-900 rounded-2xl shadow-[6px_6px_0px_0px_#0f172a] text-slate-900 flex flex-col overflow-hidden"
  >
    <!-- Header Bar -->
    <div class="flex items-center justify-between px-3 py-2 bg-slate-900 text-white border-b-2 border-slate-900 select-none">
      <div class="flex items-center gap-2 flex-1">
        <MessageCircle class="w-4 h-4 text-amber-400" />
        <span class="font-extrabold text-xs font-heading tracking-wide">Chat & People</span>
      </div>

      <button
        type="button"
        @click="emit('close')"
        class="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
        title="Close Chat"
      >
        <ChevronDown class="w-4 h-4" />
      </button>
    </div>

    <!-- Panel Tab Bar -->
      <div class="flex items-center border-b-2 border-slate-900 bg-amber-50 p-1.5 gap-1">
        <button
          type="button"
          @click="activeTab = 'spatial'"
          :class="`flex-1 py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all font-heading ${
            activeTab === 'spatial'
              ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
              : 'text-slate-700 hover:text-slate-950'
          }`"
        >
          <Radio class="w-3.5 h-3.5" /> Spatial
        </button>
        <button
          type="button"
          @click="activeTab = 'global'"
          :class="`flex-1 py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all font-heading ${
            activeTab === 'global'
              ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
              : 'text-slate-700 hover:text-slate-950'
          }`"
        >
          <MessageSquare class="w-3.5 h-3.5" /> Room
        </button>
        <button
          type="button"
          @click="activeTab = 'users'"
          :class="`flex-1 py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all font-heading ${
            activeTab === 'users'
              ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
              : 'text-slate-700 hover:text-slate-950'
          }`"
        >
          <Users class="w-3.5 h-3.5" /> People ({{ users.length }})
        </button>
      </div>

    <!-- Content Body -->
    <div ref="messagesContainerRef" class="flex-1 p-3 overflow-y-auto flex flex-col gap-2.5 custom-scrollbar bg-slate-50">
      <template v-if="activeTab === 'users'">
        <!-- Connected Users List -->
        <div
          v-for="user in users"
          :key="user.socketId"
          class="p-2.5 bg-white border-2 border-slate-900 rounded-xl flex items-center justify-between text-xs shadow-[2px_2px_0px_0px_#0f172a]"
        >
          <div class="flex items-center gap-2.5">
            <!-- Avatar Dot -->
            <div
              class="w-8 h-8 rounded-lg border-2 border-slate-900 flex items-center justify-center font-bold text-[12px] text-white shadow-sm"
              :style="{ backgroundColor: user.avatar.outfitColor || '#3b82f6' }"
            >
              {{ user.avatar.statusEmoji || '👤' }}
            </div>

            <div class="flex flex-col">
              <div class="flex items-center gap-1.5 font-bold text-slate-900">
                <span>{{ user.name }}</span>
                <span v-if="user.socketId === currentUser.socketId" class="text-[10px] text-indigo-700 font-bold font-heading">(YOU)</span>
              </div>

              <div class="flex items-center gap-1.5 text-[10px] text-slate-600 font-bold flex-wrap">
                <span>{{ getDistance(user) === 0 ? 'Here' : `${getDistance(user)} tiles away` }}</span>
                <span
                  v-if="user.currentZoneId"
                  class="text-indigo-950 bg-indigo-100 border border-slate-900 px-1.5 py-0.2 rounded font-extrabold flex items-center gap-1"
                >
                  🔒 Private Zone
                </span>
                <span
                  v-if="user.socketId !== currentUser.socketId"
                  :class="`border px-1.5 py-0.2 rounded font-black text-[9px] ${
                    getAudioVolume(user) > 0
                      ? 'bg-emerald-100 text-emerald-950 border-emerald-700'
                      : 'bg-slate-100 text-slate-500 border-slate-300'
                  }`"
                >
                  <template v-if="getAudioVolume(user) > 0">
                    {{ currentUser.currentZoneId && user.currentZoneId ? '🔒 Zone Connected (100%)' : `🔉 ${getAudioVolume(user)}% vol` }}
                  </template>
                  <template v-else>
                    {{ user.currentZoneId || currentUser.currentZoneId ? '🔒 Zone Muted' : '🔇 Out of range' }}
                  </template>
                </span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1.5">
            <MicOff v-if="user.isMuted" class="w-3.5 h-3.5 text-rose-600" />
            <Mic v-else :class="`w-3.5 h-3.5 ${user.isSpeaking ? 'text-emerald-600 animate-pulse' : 'text-slate-400'}`" />

            <button
              v-if="user.socketId !== currentUser.socketId"
              type="button"
              @click="emit('teleportToUser', { x: user.position.x, y: user.position.y })"
              title="Teleport to User"
              class="p-1.5 bg-amber-300 hover:bg-amber-400 text-slate-950 border-2 border-slate-900 rounded-lg transition-all pixel-btn"
            >
              <Compass class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="flex flex-col gap-2.5 my-auto">
          <p v-if="filteredMessages.length === 0" class="text-center text-slate-500 font-bold text-xs py-8">
            {{
              activeTab === 'spatial'
                ? 'Spatial chat messages appear to nearby coworkers within 7 tiles.'
                : 'Room chat messages are seen by everyone in the room.'
            }}
          </p>
          <template v-else>
            <div
              v-for="msg in filteredMessages"
              :key="msg.id"
              :class="`flex flex-col max-w-[85%] ${msg.senderId === currentUser.socketId ? 'ml-auto items-end' : 'mr-auto items-start'}`"
            >
              <span class="text-[10px] text-slate-700 font-extrabold mb-0.5 px-1 font-heading">{{ msg.senderName }}</span>
              <div
                :class="`p-2.5 rounded-xl text-xs leading-relaxed border-2 border-slate-900 font-bold shadow-[2px_2px_0px_0px_#0f172a] ${
                  msg.senderId === currentUser.socketId
                    ? 'bg-amber-300 text-slate-950'
                    : 'bg-white text-slate-900'
                }`"
              >
                {{ msg.text }}
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- Input Field -->
    <form v-if="activeTab !== 'users'" @submit.prevent="handleSend" class="p-2.5 border-t-2 border-slate-900 bg-amber-50 flex gap-2">
      <input
        type="text"
        v-model="inputText"
        :placeholder="activeTab === 'spatial' ? 'Spatial chat...' : 'Room chat...'"
        class="flex-1 bg-white border-2 border-slate-900 rounded-lg px-3 py-1.5 text-xs text-slate-900 placeholder-slate-500 font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 transition-all"
      />
      <button
        type="submit"
        class="bg-indigo-500 hover:bg-indigo-600 text-white p-2 border-2 border-slate-900 rounded-lg transition-all pixel-btn"
      >
        <Send class="w-4 h-4" />
      </button>
    </form>
  </div>
</template>
