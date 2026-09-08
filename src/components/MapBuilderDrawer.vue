<script setup lang="ts">
import { ref, watch } from "vue";
import { Hammer, Trash2, Layers, Box, X, Shield, Plus, Lock, Move, GripHorizontal, SquareDashedMousePointer, UserRoundCog } from "lucide-vue-next";
import type { TileType, MapObject, ObjectType, PrivateZone, User } from "../types";

const props = defineProps<{
  isOpen: boolean;
  builderAction: "place" | "erase" | "move";
  selectedTile: TileType;
  selectedObject: MapObject | null;
  currentMapId: string;
  privateZones: PrivateZone[];
  zoneDrawMode: boolean;
  /** Rectangle the user just dragged out on the map, if any. */
  pendingZone: { x: number; y: number; width: number; height: number } | null;
  /** Test ("dummy") users currently placed on the map - admin-only, so empty for everyone else. */
  dummyUsers: User[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "setBuilderAction", action: "place" | "erase" | "move"): void;
  (e: "setSelectedTile", tile: TileType): void;
  (e: "setSelectedObject", obj: MapObject | null): void;
  (e: "switchMapPreset", presetId: string): void;
  (e: "addZone", zone: PrivateZone): void;
  (e: "removeZone", zoneId: string): void;
  (e: "setZoneDrawMode", enabled: boolean): void;
  (e: "placeDummy"): void;
  (e: "removeDummy", dummyId: string): void;
}>();

const activeCategory = ref<"build" | "zones" | "testers">("build");

// Popup Dragging State
const popupPos = ref({ x: 16, y: 64 });
const isDraggingPopup = ref(false);
const dragStart = ref({ x: 0, y: 0 });
const initialPopupPos = ref({ x: 0, y: 0 });

function startPopupDrag(e: PointerEvent) {
  const target = e.target as HTMLElement;
  if (target.closest("button") || target.closest("input")) return;

  isDraggingPopup.value = true;
  dragStart.value = { x: e.clientX, y: e.clientY };
  initialPopupPos.value = { ...popupPos.value };

  try {
    (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId);
  } catch (_) {}
}

function onPopupDrag(e: PointerEvent) {
  if (!isDraggingPopup.value) return;

  const dx = e.clientX - dragStart.value.x;
  const dy = e.clientY - dragStart.value.y;

  let newX = initialPopupPos.value.x + dx;
  let newY = initialPopupPos.value.y + dy;

  const maxWidth = Math.max(10, window.innerWidth - 330);
  const maxHeight = Math.max(10, window.innerHeight - 100);
  newX = Math.max(10, Math.min(maxWidth, newX));
  newY = Math.max(10, Math.min(maxHeight, newY));

  popupPos.value = { x: newX, y: newY };
}

function stopPopupDrag(e: PointerEvent) {
  if (isDraggingPopup.value) {
    isDraggingPopup.value = false;
    try {
      (e.currentTarget as HTMLElement)?.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }
}

// Form state for creating a new private audio zone
const newZoneName = ref("");
const newZoneX = ref(1);
const newZoneY = ref(1);
const newZoneW = ref(6);
const newZoneH = ref(6);
const newZoneColor = ref("rgba(59, 130, 246, 0.2)");

const COLOR_PRESETS = [
  { label: "Blue", value: "rgba(59, 130, 246, 0.22)", border: "#3b82f6" },
  { label: "Purple", value: "rgba(168, 85, 247, 0.22)", border: "#a855f7" },
  { label: "Emerald", value: "rgba(34, 197, 94, 0.22)", border: "#22c55e" },
  { label: "Amber", value: "rgba(245, 158, 11, 0.22)", border: "#f59e0b" },
  { label: "Rose", value: "rgba(244, 63, 94, 0.22)", border: "#f43f5e" },
];

// A rectangle dragged out on the map fills the same fields the user could type into, so the
// numbers stay visible and adjustable rather than the drag being an opaque separate path.
watch(
  () => props.pendingZone,
  (rect) => {
    if (!rect) return;
    newZoneX.value = rect.x;
    newZoneY.value = rect.y;
    newZoneW.value = rect.width;
    newZoneH.value = rect.height;
    activeCategory.value = "zones";
  }
);

function handleCreateZone() {
  if (!newZoneName.value.trim()) return;
  const zone: PrivateZone = {
    id: `zone_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    name: newZoneName.value.trim(),
    color: newZoneColor.value,
    x: Math.max(0, newZoneX.value),
    y: Math.max(0, newZoneY.value),
    width: Math.max(1, newZoneW.value),
    height: Math.max(1, newZoneH.value),
  };
  emit("addZone", zone);
  newZoneName.value = "";
}

const TILE_PRESETS: { type: TileType; label: string; color: string }[] = [
  { type: "floor_wood", label: "Hardwood Floor", color: "#c89f6d" },
  { type: "floor_carpet", label: "Office Carpet", color: "#48566a" },
  { type: "floor_tile", label: "Marble Tile", color: "#f1f5f9" },
  { type: "floor_grass", label: "Outdoor Grass", color: "#4d7c0f" },
  { type: "floor_concrete", label: "Grey Concrete", color: "#64748b" },
  { type: "wall_brick", label: "Brick Wall", color: "#b91c1c" },
  { type: "wall_wood", label: "Wood Wall", color: "#854d0e" },
  { type: "water", label: "Pool Water", color: "#06b6d4" },
];

const OBJECT_PRESETS: { type: ObjectType; name: string; icon: string; width: number; height: number; isBlocking: boolean; data?: any }[] = [
  {
    type: "desk",
    name: "Work Desk",
    icon: "🖥️",
    width: 2,
    height: 1,
    isBlocking: true,
    data: {
      deskState: {
        deskLabel: "Workstation Desk",
        equipment: "laptop",
        stickyNotes: [],
      },
    },
  },
  { type: "chair", name: "Office Chair", icon: "🪑", width: 1, height: 1, isBlocking: false },
  { type: "conference_table", name: "Conference Table", icon: "🏢", width: 3, height: 2, isBlocking: true },
  { type: "plant", name: "Potted Plant", icon: "🌿", width: 1, height: 1, isBlocking: true },
  { type: "whiteboard", name: "Whiteboard", icon: "📋", width: 2, height: 1, isBlocking: true },
  { type: "sticky_notes", name: "Notice Board", icon: "📌", width: 2, height: 1, isBlocking: true },
  { type: "game_table", name: "Arcade Table", icon: "🎮", width: 2, height: 2, isBlocking: true },
  { type: "bookshelf", name: "Bookshelf", icon: "📚", width: 1, height: 2, isBlocking: true },
];
</script>

<template>
  <div
    v-if="isOpen"
    :style="{ top: `${popupPos.y}px`, left: `${popupPos.x}px`, maxHeight: `calc(100vh - ${popupPos.y + 24}px)` }"
    class="fixed w-80 bg-white border-3 border-slate-900 rounded-2xl p-4 shadow-[6px_6px_0px_0px_#0f172a] z-40 text-slate-900 flex flex-col gap-3 overflow-hidden select-none"
  >
    <!-- Header (Draggable Handle) -->
    <div
      @pointerdown="startPopupDrag"
      @pointermove="onPopupDrag"
      @pointerup="stopPopupDrag"
      @pointercancel="stopPopupDrag"
      class="shrink-0 flex items-center justify-between border-b-2 border-slate-900 pb-2.5 cursor-grab active:cursor-grabbing touch-none select-none bg-amber-50/60 -mx-4 -mt-4 p-4 rounded-t-xl"
    >
      <div class="flex items-center gap-2">
        <GripHorizontal class="w-5 h-5 text-slate-500" />
        <Hammer class="w-5 h-5 text-amber-600" />
        <h3 class="text-base font-extrabold text-slate-900 font-heading">Map Builder</h3>
      </div>
      <button
        type="button"
        @click="emit('close')"
        class="p-1 rounded-lg bg-slate-100 border-2 border-slate-900 hover:bg-slate-200 text-slate-900 transition-colors pixel-btn shrink-0"
      >
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Category Tabs -->
    <div class="shrink-0 grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-xl border-2 border-slate-900">
      <button
        type="button"
        @click="activeCategory = 'build'"
        title="Tiles & Props"
        :class="`h-9 px-1 text-[11px] font-bold rounded-lg flex items-center justify-center gap-1 whitespace-nowrap transition-all pixel-btn ${
          activeCategory === 'build'
            ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
            : 'text-slate-700 hover:text-slate-950'
        }`"
      >
        <Hammer class="w-3.5 h-3.5 shrink-0" /> Tiles
      </button>
      <button
        type="button"
        @click="activeCategory = 'zones'"
        title="Private Zones"
        :class="`h-9 px-1 text-[11px] font-bold rounded-lg flex items-center justify-center gap-1 whitespace-nowrap transition-all pixel-btn ${
          activeCategory === 'zones'
            ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
            : 'text-slate-700 hover:text-slate-950'
        }`"
      >
        <Lock class="w-3.5 h-3.5 text-indigo-700 shrink-0" /> Zones
      </button>
      <button
        type="button"
        @click="activeCategory = 'testers'"
        title="Test Users"
        :class="`h-9 px-1 text-[11px] font-bold rounded-lg flex items-center justify-center gap-1 whitespace-nowrap transition-all pixel-btn ${
          activeCategory === 'testers'
            ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
            : 'text-slate-700 hover:text-slate-950'
        }`"
      >
        <UserRoundCog class="w-3.5 h-3.5 text-purple-700 shrink-0" /> Testers
      </button>
    </div>

    <!-- Only the category body scrolls. Previously the whole panel did, so scrolling down to
         reach "Create Private Zone" took the drag handle and the tab switcher off screen. -->
    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1 -mr-1 flex flex-col gap-4">
    <template v-if="activeCategory === 'build'">
      <!-- Map Preset Switcher -->
      <div>
        <label class="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 block font-heading">
          Map Presets
        </label>
        <div class="grid grid-cols-2 gap-2">
          <button
            type="button"
            @click="emit('switchMapPreset', 'office_default')"
            :class="`px-2.5 py-2 text-xs font-bold rounded-lg border-2 border-slate-900 text-left transition-all pixel-btn ${
              currentMapId === 'office_default'
                ? 'bg-amber-300 text-slate-950 shadow-[2px_2px_0px_0px_#0f172a]'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-900'
            }`"
          >
            🏢 Tech HQ
          </button>
          <button
            type="button"
            @click="emit('switchMapPreset', 'beach_retreat')"
            :class="`px-2.5 py-2 text-xs font-bold rounded-lg border-2 border-slate-900 text-left transition-all pixel-btn ${
              currentMapId === 'beach_retreat'
                ? 'bg-amber-300 text-slate-950 shadow-[2px_2px_0px_0px_#0f172a]'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-900'
            }`"
          >
            🌴 Beachside
          </button>
        </div>
      </div>

      <!-- Mode Action Selector -->
      <div class="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl border-2 border-slate-900">
        <button
          type="button"
          @click="emit('setBuilderAction', 'place')"
          :class="`py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all pixel-btn ${
            builderAction === 'place' ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]' : 'text-slate-700 hover:text-slate-950'
          }`"
        >
          <Hammer class="w-3.5 h-3.5" /> Place
        </button>
        <button
          type="button"
          @click="emit('setBuilderAction', 'move')"
          :class="`py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all pixel-btn ${
            builderAction === 'move' ? 'bg-indigo-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]' : 'text-slate-700 hover:text-slate-950'
          }`"
        >
          <Move class="w-3.5 h-3.5" /> Move
        </button>
        <button
          type="button"
          @click="emit('setBuilderAction', 'erase')"
          :class="`py-1.5 text-xs font-bold rounded-lg flex items-center justify-center gap-1 transition-all pixel-btn ${
            builderAction === 'erase' ? 'bg-rose-400 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]' : 'text-slate-700 hover:text-slate-950'
          }`"
        >
          <Trash2 class="w-3.5 h-3.5" /> Erase
        </button>
      </div>

      <!-- Placement Palettes -->
      <template v-if="builderAction === 'place'">
        <!-- Tiles Palette -->
        <div>
          <div class="flex items-center gap-1.5 text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 font-heading">
            <Layers class="w-4 h-4 text-slate-700" />
            <span>Floor & Walls</span>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="t in TILE_PRESETS"
              :key="t.type"
              type="button"
              @click="() => {
                emit('setSelectedTile', t.type);
                emit('setSelectedObject', null);
              }"
              :title="t.label"
              :class="`min-h-11 p-2 rounded-lg border-2 border-slate-900 text-left text-[11px] leading-tight flex items-center gap-2 transition-all pixel-btn ${
                selectedTile === t.type && !selectedObject
                  ? 'bg-amber-300 text-slate-950 font-bold shadow-[2px_2px_0px_0px_#0f172a]'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-900 font-semibold'
              }`"
            >
              <span class="w-4 h-4 shrink-0 rounded border border-slate-900 shadow-sm" :style="{ backgroundColor: t.color }" />
              <span class="min-w-0">{{ t.label }}</span>
            </button>
          </div>
        </div>

        <!-- Interactive Objects Palette -->
        <div>
          <div class="flex items-center gap-1.5 text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 font-heading">
            <Box class="w-4 h-4 text-slate-700" />
            <span>Furniture & Props</span>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="obj in OBJECT_PRESETS"
              :key="obj.type"
              type="button"
              @click="() => {
                emit('setSelectedObject', {
                  id: '',
                  type: obj.type,
                  name: obj.name,
                  x: 0,
                  y: 0,
                  width: obj.width,
                  height: obj.height,
                  isBlocking: obj.isBlocking,
                  data: obj.data ? JSON.parse(JSON.stringify(obj.data)) : undefined,
                });
              }"
              :title="obj.name"
              :class="`min-h-11 p-2 rounded-lg border-2 border-slate-900 text-left text-[11px] leading-tight flex items-center gap-2 transition-all pixel-btn ${
                selectedObject?.type === obj.type
                  ? 'bg-amber-300 text-slate-950 font-bold shadow-[2px_2px_0px_0px_#0f172a]'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-900 font-semibold'
              }`"
            >
              <span class="text-base shrink-0">{{ obj.icon }}</span>
              <div class="flex flex-col min-w-0">
                <span class="font-semibold">{{ obj.name }}</span>
                <span class="text-[10px] text-slate-600 font-bold">{{ obj.width }}x{{ obj.height }} grid</span>
              </div>
            </button>
          </div>
        </div>
      </template>
    </template>

    <!-- PRIVATE ZONES CATEGORY -->
    <template v-else-if="activeCategory === 'zones'">
      <div class="flex flex-col gap-3">
        <div class="p-2.5 bg-indigo-50 border-2 border-slate-900 rounded-xl text-xs text-indigo-950 font-semibold leading-relaxed">
          <p class="font-extrabold flex items-center gap-1 text-indigo-900 font-heading mb-1">
            <Lock class="w-3.5 h-3.5 text-indigo-600" /> WebRTC Audio Isolation
          </p>
          Users inside a private zone hear only others in that same zone. Audio is 100% muted for users outside.
        </div>

        <!-- Existing Zones List -->
        <div>
          <label class="text-xs font-bold text-slate-900 uppercase tracking-wider mb-1.5 block font-heading">
            Active Private Zones ({{ privateZones.length }})
          </label>

          <div v-if="privateZones.length === 0" class="p-3 bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl text-xs text-slate-500 text-center font-semibold">
            No private audio zones defined on this map yet.
          </div>

          <div v-else class="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
            <div
              v-for="z in privateZones"
              :key="z.id"
              class="p-2.5 bg-white border-2 border-slate-900 rounded-xl flex items-center justify-between shadow-[2px_2px_0px_0px_#0f172a]"
            >
              <div class="flex items-center gap-2 min-w-0">
                <div class="w-4 h-4 rounded-full border border-slate-900 shrink-0" :style="{ backgroundColor: z.color }" />
                <div class="flex flex-col min-w-0">
                  <span class="text-xs font-extrabold text-slate-900 truncate font-heading">🔒 {{ z.name }}</span>
                  <span class="text-[10px] text-slate-600 font-bold">X:{{ z.x }} Y:{{ z.y }} | {{ z.width }}x{{ z.height }} tiles</span>
                </div>
              </div>

              <button
                type="button"
                @click="emit('removeZone', z.id)"
                class="p-1 rounded bg-rose-100 hover:bg-rose-200 text-rose-800 border border-slate-900 pixel-btn shrink-0"
                title="Delete Zone"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <!-- Add New Zone Form -->
        <form @submit.prevent="handleCreateZone" class="p-3 bg-slate-50 border-2 border-slate-900 rounded-xl flex flex-col gap-2.5">
          <label class="text-xs font-bold text-slate-900 uppercase tracking-wider font-heading">
            Add New Audio Zone
          </label>

          <input
            v-model="newZoneName"
            type="text"
            placeholder="Zone Name (e.g. Focus Pod)"
            required
            class="px-3 py-1.5 bg-white border-2 border-slate-900 rounded-lg text-xs font-bold text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
          />

          <!-- Drag the rectangle out on the map rather than working the tile numbers out by
               hand. The fields below stay authoritative and editable either way. -->
          <button
            type="button"
            @click="emit('setZoneDrawMode', !zoneDrawMode)"
            :class="`w-full text-xs font-extrabold py-2 px-3 rounded-xl border-2 border-slate-900 flex items-center justify-center gap-1.5 whitespace-nowrap pixel-btn ${
              zoneDrawMode
                ? 'bg-indigo-500 text-white shadow-[2px_2px_0px_0px_#0f172a]'
                : 'bg-white text-slate-900 hover:bg-slate-100'
            }`"
          >
            <SquareDashedMousePointer class="w-4 h-4" />
            {{ zoneDrawMode ? 'Drawing - drag the map' : 'Draw zone on map' }}
          </button>

          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label class="text-[10px] font-bold text-slate-600">Start Tile X, Y</label>
              <div class="flex gap-1 mt-0.5">
                <input v-model.number="newZoneX" type="number" min="0" class="w-full px-2 py-1 border-2 border-slate-900 rounded font-bold" />
                <input v-model.number="newZoneY" type="number" min="0" class="w-full px-2 py-1 border-2 border-slate-900 rounded font-bold" />
              </div>
            </div>

            <div>
              <label class="text-[10px] font-bold text-slate-600">Size (W x H)</label>
              <div class="flex gap-1 mt-0.5">
                <input v-model.number="newZoneW" type="number" min="1" class="w-full px-2 py-1 border-2 border-slate-900 rounded font-bold" />
                <input v-model.number="newZoneH" type="number" min="1" class="w-full px-2 py-1 border-2 border-slate-900 rounded font-bold" />
              </div>
            </div>
          </div>

          <div>
            <label class="text-[10px] font-bold text-slate-600 block mb-1">Zone Overlay Color</label>
            <div class="flex gap-1.5">
              <button
                v-for="c in COLOR_PRESETS"
                :key="c.value"
                type="button"
                @click="newZoneColor = c.value"
                :class="`w-6 h-6 rounded-full border-2 transition-transform ${
                  newZoneColor === c.value ? 'scale-110 border-slate-950 shadow-md ring-2 ring-amber-400' : 'border-slate-400'
                }`"
                :style="{ backgroundColor: c.value, borderColor: c.border }"
              />
            </div>
          </div>

          <button
            type="submit"
            class="mt-1 w-full bg-amber-400 hover:bg-amber-500 text-slate-950 font-heading text-xs font-extrabold py-2 px-3 rounded-xl border-2 border-slate-900 flex items-center justify-center gap-1.5 pixel-btn shadow-[2px_2px_0px_0px_#0f172a]"
          >
            <Plus class="w-4 h-4" /> Create Private Zone
          </button>
        </form>
      </div>
    </template>

    <!-- TEST USERS CATEGORY -->
    <template v-else-if="activeCategory === 'testers'">
      <div class="flex flex-col gap-3">
        <div class="p-2.5 bg-purple-50 border-2 border-slate-900 rounded-xl text-xs text-purple-950 font-semibold leading-relaxed">
          <p class="font-extrabold flex items-center gap-1 text-purple-900 font-heading mb-1">
            <UserRoundCog class="w-3.5 h-3.5 text-purple-600" /> Test Users
          </p>
          Placed at your current tile and only ever visible to admins. Each one emits a quiet
          continuous tone and a test video pattern so you can check proximity audio and the
          video dock on your own.
        </div>

        <div>
          <label class="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 block font-heading">
            Placed ({{ dummyUsers.length }})
          </label>

          <p v-if="dummyUsers.length === 0" class="text-xs text-slate-500 font-bold italic px-1">
            No test users placed yet.
          </p>

          <div v-else class="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
            <div
              v-for="d in dummyUsers"
              :key="d.socketId"
              class="flex items-center justify-between gap-2 p-2 bg-slate-50 border-2 border-slate-900 rounded-lg"
            >
              <div class="flex flex-col min-w-0">
                <span class="text-xs font-extrabold text-slate-900 truncate font-heading">{{ d.name }}</span>
                <span class="text-[10px] text-slate-600 font-bold">X:{{ d.position.x }} Y:{{ d.position.y }}</span>
              </div>

              <button
                type="button"
                @click="emit('removeDummy', d.socketId)"
                class="p-1 rounded bg-rose-100 hover:bg-rose-200 text-rose-800 border border-slate-900 pixel-btn shrink-0"
                title="Remove Test User"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          @click="emit('placeDummy')"
          class="w-full bg-purple-300 hover:bg-purple-400 text-slate-950 font-heading text-xs font-extrabold py-2 px-3 rounded-xl border-2 border-slate-900 flex items-center justify-center gap-1.5 pixel-btn shadow-[2px_2px_0px_0px_#0f172a]"
        >
          <Plus class="w-4 h-4" /> Place Test User Here
        </button>
      </div>
    </template>

    </div>

    <!-- Contextual: the tip is pinned, so it should be about the tab you are actually on. -->
    <p class="shrink-0 text-[11px] text-slate-900 bg-amber-100 p-2.5 rounded-lg border-2 border-slate-900 font-bold leading-relaxed shadow-[2px_2px_0px_0px_#0f172a]">
      <template v-if="activeCategory === 'build'">
        💡 Click grid cells to paint tiles or place props. Drag objects on the map to move them.
      </template>
      <template v-else-if="activeCategory === 'zones'">
        💡 Hit "Draw zone on map", then drag a rectangle over the map to set the bounds.
      </template>
      <template v-else>
        💡 Walk to where you want a tester, then hit "Place Test User Here".
      </template>
    </p>
  </div>
</template>
