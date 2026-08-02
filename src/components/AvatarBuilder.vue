<script setup lang="ts">
import { ref } from 'vue';
import { Sparkles, X, Check, User, Shirt, Smile, Wand2, HardDrive } from 'lucide-vue-next';
import type { AvatarCustomization } from '../types';

const props = defineProps<{
  avatar: AvatarCustomization;
  showClose?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:avatar', avatar: AvatarCustomization): void;
  (e: 'close'): void;
}>();

const activeCategory = ref<'appearance' | 'outfit' | 'status'>('appearance');

function update<K extends keyof AvatarCustomization>(key: K, value: AvatarCustomization[K]) {
  emit('update:avatar', {
    ...props.avatar,
    [key]: value,
  });
}

const SKIN_TONES = ['#f87171', '#fbbf24', '#fca5a5', '#d97706', '#881337', '#78350f', '#fed7aa', '#451a03'];
const HAIR_STYLES = ['short', 'long', 'curly', 'afro', 'bald'];
const HAIR_COLORS = ['#1e293b', '#b45309', '#eab308', '#dc2626', '#6b7280', '#0284c7', '#ec4899'];
const OUTFIT_COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#f97316', '#64748b', '#0f172a', '#e11d48'];
const HATS = ['none', 'cap', 'beanie'];
const EMOJIS = ['👋', '💻', '☕', '🎧', '🚀', '🔥', '🤫', '🌴', '🧠', '⚡', '✨', '🎯'];

function randomize() {
  const randomSkin = SKIN_TONES[Math.floor(Math.random() * SKIN_TONES.length)];
  const randomHairStyle = HAIR_STYLES[Math.floor(Math.random() * HAIR_STYLES.length)];
  const randomHairColor = HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)];
  const randomOutfit = OUTFIT_COLORS[Math.floor(Math.random() * OUTFIT_COLORS.length)];
  const randomGlasses = Math.random() > 0.5;
  const randomHat = HATS[Math.floor(Math.random() * HATS.length)];
  const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

  emit('update:avatar', {
    skinColor: randomSkin,
    hairStyle: randomHairStyle,
    hairColor: randomHairColor,
    outfitColor: randomOutfit,
    glasses: randomGlasses,
    hatStyle: randomHat,
    statusEmoji: randomEmoji,
  });
}
</script>

<template>
  <div class="bg-white border-3 border-slate-900 rounded-2xl p-3.5 sm:p-5 shadow-[8px_8px_0px_0px_#0f172a] text-slate-900 max-w-sm sm:max-w-md md:max-w-lg w-full relative flex flex-col max-h-[85vh] sm:max-h-[90vh] my-auto overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between mb-3 border-b-2 border-slate-900 pb-2.5 shrink-0">
      <div class="flex items-center gap-2">
        <div class="p-1.5 bg-amber-300 text-slate-950 rounded-lg border-2 border-slate-900">
          <Sparkles class="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
        <div>
          <div class="flex items-center gap-1.5">
            <h3 class="text-sm sm:text-base font-extrabold text-slate-900 tracking-tight font-heading">Avatar Studio</h3>
            <span class="text-[9px] px-1.5 py-0.5 font-bold rounded bg-emerald-100 text-emerald-800 border border-emerald-400 flex items-center gap-1">
              <HardDrive class="w-2.5 h-2.5" /> Auto-saved
            </span>
          </div>
          <p class="text-[10px] sm:text-xs text-slate-600 font-bold">Customize & persist your pixel presence</p>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          @click="randomize"
          title="Randomize Avatar"
          class="p-1.5 sm:p-2 rounded-lg bg-amber-300 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1 transition-all pixel-btn border-2 border-slate-900"
        >
          <Wand2 class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          <span class="hidden xs:inline font-heading">Random</span>
        </button>
        <button
          v-if="showClose"
          type="button"
          @click="emit('close')"
          class="p-1.5 sm:p-2 rounded-lg bg-slate-100 hover:bg-slate-200 border-2 border-slate-900 text-slate-900 transition-colors pixel-btn"
        >
          <X class="w-4 h-4 sm:w-5 sm:h-5" />
        </button>
      </div>
    </div>

    <!-- Live Preview Stage -->
    <div class="flex flex-col items-center justify-center py-3.5 sm:py-4 bg-amber-50 border-2 border-slate-900 rounded-xl mb-3 relative overflow-hidden shadow-[3px_3px_0px_0px_#0f172a] shrink-0">
      <!-- Background Grid Accent -->
      <div class="absolute inset-0 bg-[radial-gradient(#0f172a_1px,transparent_1px)] [background-size:12px_12px] opacity-20" />

      <div class="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-white border-3 border-slate-900 flex items-center justify-center relative shadow-[4px_4px_0px_0px_#0f172a] overflow-hidden z-10 transition-all pixel-rendering">
        <div class="relative flex flex-col items-center justify-center">
          <!-- Hat -->
          <div
            v-if="avatar.hatStyle === 'cap'"
            class="w-10 h-3 bg-red-600 border-2 border-slate-900 rounded-t-sm relative -mb-1 z-30"
          >
            <div class="w-12 h-1 bg-red-800 border-b border-slate-900 -ml-1 mt-2" />
          </div>
          <div
            v-else-if="avatar.hatStyle === 'beanie'"
            class="w-10 h-6 bg-emerald-600 border-2 border-slate-900 rounded-t-md relative -mb-2 z-30"
          >
            <div class="w-3 h-3 bg-amber-400 border border-slate-900 rounded-full mx-auto -mt-1.5" />
          </div>

          <!-- Hair (Distinct Styles when hat is none) -->
          <template v-if="avatar.hatStyle === 'none'">
            <!-- Short Hair -->
            <div
              v-if="avatar.hairStyle === 'short'"
              class="w-11 h-4 border-t-2 border-x-2 border-slate-900 rounded-t-lg relative -mb-1.5 z-10 transition-colors"
              :style="{ backgroundColor: avatar.hairColor }"
            />

            <!-- Long Hair -->
            <div v-else-if="avatar.hairStyle === 'long'" class="relative -mb-1.5 z-10">
              <div
                class="w-11 h-4 border-t-2 border-x-2 border-slate-900 rounded-t-lg transition-colors"
                :style="{ backgroundColor: avatar.hairColor }"
              />
              <div
                class="w-3 h-8 border-2 border-slate-900 rounded-b-md absolute -left-1.5 top-2 z-10 transition-colors"
                :style="{ backgroundColor: avatar.hairColor }"
              />
              <div
                class="w-3 h-8 border-2 border-slate-900 rounded-b-md absolute -right-1.5 top-2 z-10 transition-colors"
                :style="{ backgroundColor: avatar.hairColor }"
              />
            </div>

            <!-- Curly Hair -->
            <div v-else-if="avatar.hairStyle === 'curly'" class="relative -mb-2 z-10">
              <div
                class="w-13 h-5 border-2 border-slate-900 rounded-t-full transition-colors flex justify-between px-0.5 pt-0.5"
                :style="{ backgroundColor: avatar.hairColor }"
              >
                <div class="w-2.5 h-2.5 rounded-full border border-slate-900/40 bg-white/20" />
                <div class="w-2.5 h-2.5 rounded-full border border-slate-900/40 bg-white/20" />
                <div class="w-2.5 h-2.5 rounded-full border border-slate-900/40 bg-white/20" />
              </div>
            </div>

            <!-- Afro Hair -->
            <div v-else-if="avatar.hairStyle === 'afro'" class="relative -mb-7 z-0">
              <div
                class="w-16 h-14 border-2 border-slate-900 rounded-full transition-colors flex items-center justify-center shadow-inner"
                :style="{ backgroundColor: avatar.hairColor }"
              >
                <div class="w-11 h-9 rounded-full border border-slate-900/20 bg-white/10" />
              </div>
            </div>
          </template>

          <!-- Head / Face -->
          <div
            class="w-12 h-12 rounded-xl flex flex-col items-center justify-center relative border-2 border-slate-900 transition-colors z-20"
            :style="{ backgroundColor: avatar.skinColor }"
          >
            <!-- Glasses -->
            <div v-if="avatar.glasses" class="flex items-center gap-1 z-20">
              <div class="w-3.5 h-3.5 border-2 border-slate-900 bg-cyan-200" />
              <div class="w-1 h-0.5 bg-slate-900" />
              <div class="w-3.5 h-3.5 border-2 border-slate-900 bg-cyan-200" />
            </div>
            <!-- Eyes -->
            <div v-else class="flex items-center gap-2.5 z-20 my-0.5">
              <div class="w-2 h-2 bg-slate-900" />
              <div class="w-2 h-2 bg-slate-900" />
            </div>
            <!-- Smile -->
            <div class="w-4 h-1 border-b-2 border-slate-900 mt-0.5" />
          </div>

          <!-- Body / Outfit -->
          <div
            class="w-14 h-8 border-2 border-slate-900 rounded-t-lg mt-0.5 transition-colors z-20"
            :style="{ backgroundColor: avatar.outfitColor }"
          />

          <!-- Status Emoji Badge -->
          <div class="absolute -bottom-1 -right-2 bg-amber-300 border-2 border-slate-900 rounded-md w-7 h-7 flex items-center justify-center text-sm shadow-[2px_2px_0px_0px_#0f172a] z-30">
            {{ avatar.statusEmoji }}
          </div>
        </div>
      </div>
    </div>

    <!-- Category Tabs -->
    <div class="flex items-center gap-1 bg-slate-100 p-1 rounded-xl mb-3 border-2 border-slate-900 shrink-0">
      <button
        type="button"
        @click="activeCategory = 'appearance'"
        :class="`flex-1 py-1.5 px-1 sm:px-2 text-[11px] sm:text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all ${
          activeCategory === 'appearance'
            ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a] font-heading'
            : 'text-slate-700 hover:text-slate-950 font-heading'
        }`"
      >
        <User class="w-3.5 h-3.5 shrink-0" /> <span>Look</span>
      </button>
      <button
        type="button"
        @click="activeCategory = 'outfit'"
        :class="`flex-1 py-1.5 px-1 sm:px-2 text-[11px] sm:text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all ${
          activeCategory === 'outfit'
            ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a] font-heading'
            : 'text-slate-700 hover:text-slate-950 font-heading'
        }`"
      >
        <Shirt class="w-3.5 h-3.5 shrink-0" /> <span>Outfit</span>
      </button>
      <button
        type="button"
        @click="activeCategory = 'status'"
        :class="`flex-1 py-1.5 px-1 sm:px-2 text-[11px] sm:text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all ${
          activeCategory === 'status'
            ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a] font-heading'
            : 'text-slate-700 hover:text-slate-950 font-heading'
        }`"
      >
        <Smile class="w-3.5 h-3.5 shrink-0" /> <span>Status</span>
      </button>
    </div>

    <!-- Category Content Options (Scrollable) -->
    <div class="flex-1 overflow-y-auto px-2 py-2 space-y-4 custom-scrollbar min-h-0">
      <!-- Appearance Tab -->
      <template v-if="activeCategory === 'appearance'">
        <!-- Skin Color -->
        <div>
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Skin Tone
          </label>
          <div class="flex gap-2 flex-wrap p-1.5 items-center">
            <button
              v-for="c in SKIN_TONES"
              :key="c"
              type="button"
              @click="update('skinColor', c)"
              :class="`w-7 h-7 sm:w-8 sm:h-8 rounded-lg border-2 border-slate-900 transition-all shrink-0 ${
                avatar.skinColor === c ? 'scale-110 shadow-[2px_2px_0px_0px_#0f172a] ring-2 ring-amber-400 z-10' : 'hover:scale-105'
              }`"
              :style="{ backgroundColor: c }"
            />
          </div>
        </div>

        <!-- Hair Style -->
        <div>
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Hair Style
          </label>
          <div class="grid grid-cols-3 sm:grid-cols-5 gap-1.5 p-1">
            <button
              v-for="style in HAIR_STYLES"
              :key="style"
              type="button"
              @click="update('hairStyle', style)"
              :class="`py-1.5 px-1 text-[11px] sm:text-xs capitalize rounded-lg border-2 border-slate-900 transition-all pixel-btn font-bold truncate text-center ${
                avatar.hairStyle === style
                  ? 'bg-indigo-500 text-white'
                  : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
              }`"
            >
              {{ style }}
            </button>
          </div>
        </div>

        <!-- Hair Color -->
        <div v-if="avatar.hairStyle !== 'bald'">
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Hair Color
          </label>
          <div class="flex gap-2 flex-wrap p-1.5 items-center">
            <button
              v-for="c in HAIR_COLORS"
              :key="c"
              type="button"
              @click="update('hairColor', c)"
              :class="`w-7 h-7 sm:w-8 sm:h-8 rounded-lg border-2 border-slate-900 transition-all shrink-0 ${
                avatar.hairColor === c ? 'scale-110 shadow-[2px_2px_0px_0px_#0f172a] ring-2 ring-amber-400 z-10' : 'hover:scale-105'
              }`"
              :style="{ backgroundColor: c }"
            />
          </div>
        </div>
      </template>

      <!-- Outfit & Hats Tab -->
      <template v-else-if="activeCategory === 'outfit'">
        <!-- Outfit Color -->
        <div>
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Shirt / Outfit Color
          </label>
          <div class="flex gap-2 flex-wrap p-1.5 items-center">
            <button
              v-for="c in OUTFIT_COLORS"
              :key="c"
              type="button"
              @click="update('outfitColor', c)"
              :class="`w-7 h-7 sm:w-8 sm:h-8 rounded-lg border-2 border-slate-900 transition-all shrink-0 ${
                avatar.outfitColor === c ? 'scale-110 shadow-[2px_2px_0px_0px_#0f172a] ring-2 ring-amber-400 z-10' : 'hover:scale-105'
              }`"
              :style="{ backgroundColor: c }"
            />
          </div>
        </div>

        <!-- Hat Style -->
        <div>
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Headwear & Hats
          </label>
          <div class="grid grid-cols-3 gap-1.5 sm:gap-2 p-1">
            <button
              v-for="hat in HATS"
              :key="hat"
              type="button"
              @click="update('hatStyle', hat)"
              :class="`py-2 text-[11px] sm:text-xs capitalize rounded-lg border-2 border-slate-900 transition-all pixel-btn font-bold truncate text-center ${
                avatar.hatStyle === hat
                  ? 'bg-indigo-500 text-white'
                  : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
              }`"
            >
              {{ hat }}
            </button>
          </div>
        </div>
      </template>

      <!-- Status & Extras Tab -->
      <template v-else>
        <!-- Glasses Toggle -->
        <div>
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Eyewear
          </label>
          <div class="p-1">
            <button
              type="button"
              @click="update('glasses', !avatar.glasses)"
              :class="`w-full py-2 px-3 text-[11px] sm:text-xs rounded-lg border-2 border-slate-900 transition-all flex items-center justify-between font-bold pixel-btn ${
                avatar.glasses
                  ? 'bg-indigo-500 text-white'
                  : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
              }`"
            >
              <span>Glasses Accessory</span>
              <Check v-if="avatar.glasses" class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- Status Emoji -->
        <div>
          <label class="text-[10px] sm:text-[11px] font-bold text-slate-900 uppercase tracking-wider mb-1 block font-heading">
            Status Bubble Emoji
          </label>
          <div class="grid grid-cols-4 sm:grid-cols-6 gap-1.5 sm:gap-2 p-1">
            <button
              v-for="emoji in EMOJIS"
              :key="emoji"
              type="button"
              @click="update('statusEmoji', emoji)"
              :class="`h-9 sm:h-10 rounded-lg flex items-center justify-center text-base sm:text-lg border-2 border-slate-900 transition-all pixel-btn ${
                avatar.statusEmoji === emoji
                  ? 'bg-amber-300'
                  : 'bg-slate-100 hover:bg-slate-200'
              }`"
            >
              {{ emoji }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
