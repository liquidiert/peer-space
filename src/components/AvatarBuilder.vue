<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Sparkles, X, Check, User, Shirt, Smile, Wand2, HardDrive, Footprints } from 'lucide-vue-next';
import type { AvatarCustomization, Direction } from '../types';
import { AV_H, AV_W, drawAvatarSprite } from '../lib/avatarSprite';

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

// The sprite derives its own shadows and highlights from whatever is picked here (see
// rampFrom in lib/pixelArt), so these are chosen as *base* tones. The previous set was raw
// Tailwind - a red and a wine as "skin", a pure magenta as "hair" - which produced
// characters that could not sit in the same room as each other.
const SKIN_TONES = ['#f8d9bd', '#f0c19b', '#e0a678', '#c8875a', '#a66a41', '#7d4b2e', '#5a3520', '#3d2317'];
const HAIR_STYLES = ['short', 'long', 'curly', 'afro', 'bald'];
const HAIR_COLORS = ['#2b1a10', '#5a3a20', '#9c6c41', '#d8b26a', '#b5533a', '#6b7280', '#4a6fa5', '#a05a8a'];
const OUTFIT_COLORS = ['#5b86cf', '#54b8b4', '#68b877', '#e8c268', '#e79355', '#e0705f', '#9585d6', '#d67fa4', '#48506b', '#2f3545'];
const HATS = ['none', 'cap', 'beanie'];
const EMOJIS = ['👋', '💻', '☕', '🎧', '🚀', '🔥', '🤫', '🌴', '🧠', '⚡', '✨', '🎯'];

// --- Live preview -----------------------------------------------------------------
// Drawn with drawAvatarSprite, the same function the world canvas uses, rather than being
// re-created in HTML/CSS. The two used to be separate implementations, so every change to
// the character had to be made twice and the Studio drifted into showing something the map
// never actually rendered.
const PREVIEW_SCALE = 5;
const PREVIEW_PAD_X = 14; // room for the emoji chip, which sits outside the sprite box
const PREVIEW_PAD_Y = 8;
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const previewDirection = ref<Direction>('down');
const isWalking = ref(false);
const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'down', label: 'Front' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'up', label: 'Back' },
];

let previewFrame: number | null = null;

function drawPreview() {
  const canvas = previewCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawAvatarSprite(ctx, PREVIEW_PAD_X, PREVIEW_PAD_Y, PREVIEW_SCALE, props.avatar, {
    direction: previewDirection.value,
    walkPhase: isWalking.value ? Math.floor(Date.now() / 150) % 4 : -1,
    showEmoji: true,
  });
}

function animatePreview() {
  drawPreview();
  previewFrame = isWalking.value ? requestAnimationFrame(animatePreview) : null;
}

function toggleWalk() {
  isWalking.value = !isWalking.value;
  if (isWalking.value && previewFrame === null) animatePreview();
  else drawPreview();
}

watch(() => [props.avatar, previewDirection.value], drawPreview, { deep: true });
onMounted(() => {
  // Driven off the initial state rather than assuming it starts stopped, so the loop can
  // never be left un-started if that default ever changes.
  if (isWalking.value) animatePreview();
  else drawPreview();
});
onUnmounted(() => {
  if (previewFrame !== null) cancelAnimationFrame(previewFrame);
});

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
      <div class="absolute inset-0 bg-[radial-gradient(#0f172a_1px,transparent_1px)] bg-size-[12px_12px] opacity-20" />

      <div class="flex items-center gap-3 z-10">
        <!-- The character, drawn by the same sprite code the world canvas uses. -->
        <div class="rounded-2xl bg-white border-3 border-slate-900 flex items-center justify-center relative shadow-[4px_4px_0px_0px_#0f172a] overflow-hidden transition-all p-1">
          <canvas
            ref="previewCanvas"
            :width="AV_W * PREVIEW_SCALE + PREVIEW_PAD_X * 2"
            :height="AV_H * PREVIEW_SCALE + PREVIEW_PAD_Y * 2"
            class="pixel-rendering block"
          />
        </div>

        <!-- Facing + walk preview: the sprite is drawn per-direction and animated, so the
             Studio should let you actually see both. -->
        <div class="flex flex-col gap-1.5">
          <span class="text-[9px] font-bold uppercase tracking-wider text-slate-600 font-heading">Facing</span>
          <div class="grid grid-cols-2 gap-1">
            <button
              v-for="d in DIRECTIONS"
              :key="d.value"
              type="button"
              @click="previewDirection = d.value"
              :class="`px-2 py-1 text-[10px] font-bold rounded-md border-2 border-slate-900 transition-all pixel-btn font-heading ${
                previewDirection === d.value ? 'bg-indigo-500 text-white' : 'bg-white text-slate-900 hover:bg-slate-100'
              }`"
            >
              {{ d.label }}
            </button>
          </div>
          <button
            type="button"
            @click="toggleWalk"
            :class="`mt-0.5 px-2 py-1 text-[10px] font-bold rounded-md border-2 border-slate-900 transition-all pixel-btn font-heading flex items-center justify-center gap-1 ${
              isWalking ? 'bg-amber-300 text-slate-950' : 'bg-white text-slate-900 hover:bg-slate-100'
            }`"
          >
            <Footprints class="w-3 h-3" />
            {{ isWalking ? 'Stop' : 'Walk' }}
          </button>
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
