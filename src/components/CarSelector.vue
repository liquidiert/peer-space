<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { KART_MODELS, KART_MODEL_IDS, type KartModel } from "../lib/kartModels";
import { drawKartPreview } from "../lib/kartSprite";

/**
 * Car picker for the kart HUD: a compact button showing the current car, and a panel of four
 * cards (preview, name, tagline, stat bars). Picking a card emits `select` and closes the panel.
 */
const props = defineProps<{
  /** The car currently selected. */
  selected: KartModel;
  /** Body colour for the previews, the same colour the rider's kart is drawn in. */
  bodyColor: string;
}>();

const emit = defineEmits<{
  select: [model: KartModel];
}>();

const STATS = [
  { key: "speed", label: "Speed" },
  { key: "accel", label: "Accel" },
  { key: "handling", label: "Handling" },
  { key: "offroad", label: "Offroad" },
] as const;

const cards = KART_MODEL_IDS.map((id) => KART_MODELS[id]);

const open = ref(false);
const previews = new Map<KartModel, HTMLCanvasElement>();

function setPreview(id: KartModel, el: unknown) {
  if (el instanceof HTMLCanvasElement) previews.set(id, el);
  else previews.delete(id);
}

function drawPreviews() {
  for (const id of KART_MODEL_IDS) {
    const canvas = previews.get(id);
    if (canvas) drawKartPreview(canvas, id, props.bodyColor);
  }
}

async function toggle(e: MouseEvent) {
  // Blur so Space or Enter while driving does not reopen the panel.
  (e.currentTarget as HTMLElement | null)?.blur();
  open.value = !open.value;
  if (open.value) {
    // The canvases only exist once the panel is rendered.
    await nextTick();
    drawPreviews();
  }
}

function pick(id: KartModel, e: MouseEvent) {
  (e.currentTarget as HTMLElement | null)?.blur();
  open.value = false;
  emit("select", id);
}

watch(
  () => props.bodyColor,
  () => {
    if (open.value) drawPreviews();
  },
);
</script>

<template>
  <div>
    <button
      type="button"
      :aria-expanded="open"
      aria-haspopup="true"
      @click="toggle"
      class="bg-white hover:bg-slate-50 text-slate-900 border-2 border-slate-900 rounded-xl px-3 py-1.5 pixel-btn shadow-[3px_3px_0px_0px_#0f172a] font-heading font-extrabold text-xs cursor-pointer whitespace-nowrap"
    >
      🚗 {{ KART_MODELS[selected].name }} ▾
    </button>

    <div
      v-if="open"
      role="dialog"
      aria-label="Choose a car"
      class="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-[min(92vw,34rem)] z-50 bg-white border-2 border-slate-900 rounded-xl p-3 shadow-[4px_4px_0px_0px_#0f172a] select-none"
    >
      <div class="font-heading font-extrabold text-xs text-slate-900 mb-2">Pick your car</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <button
          v-for="m in cards"
          :key="m.id"
          type="button"
          :aria-pressed="m.id === selected"
          @click="pick(m.id, $event)"
          class="flex flex-col items-center gap-1 p-2 rounded-lg border-2 border-slate-900 pixel-btn text-center cursor-pointer"
          :class="m.id === selected ? 'bg-amber-200 shadow-[3px_3px_0px_0px_#0f172a]' : 'bg-slate-50 hover:bg-amber-50'"
        >
          <canvas
            :ref="(el) => setPreview(m.id, el)"
            width="96"
            height="64"
            style="image-rendering: pixelated"
            class="w-24 h-16 bg-sky-100 border border-slate-900 rounded"
          ></canvas>
          <span class="font-heading font-extrabold text-xs text-slate-900">{{ m.name }}</span>
          <span class="text-[10px] font-bold text-slate-600 leading-tight">{{ m.tagline }}</span>
          <span class="w-full flex flex-col gap-0.5 mt-1">
            <span v-for="stat in STATS" :key="stat.key" class="flex items-center gap-1">
              <span class="w-12 text-left text-[9px] font-bold text-slate-700">{{ stat.label }}</span>
              <span class="flex gap-px">
                <span
                  v-for="i in 5"
                  :key="i"
                  class="w-2 h-2 border border-slate-900"
                  :class="i <= m.stats[stat.key] ? 'bg-amber-400' : 'bg-white'"
                ></span>
              </span>
            </span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
