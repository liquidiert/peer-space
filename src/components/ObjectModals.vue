<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import {
  Sparkles,
  X,
  Eraser,
  Trash2,
  Plus,
  RotateCcw,
  Monitor,
  UserCheck,
  UserX,
  StickyNote as StickyIcon,
} from 'lucide-vue-next';
import type { MapObject, User, WhiteboardStroke, StickyNote, DeskState } from '../types';
import { canDeleteNote } from '../lib/notePermissions';
import { canManageDesk, type DeskEquipment } from '../lib/deskPermissions';
import {
  GAME_SPECS,
  normalizeGameState,
  resolveMove,
  specFor,
  type GameTableGame,
} from '../lib/gameTable';

const props = defineProps<{
  object: MapObject | null;
  currentUser: User;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'sendWhiteboardStroke', payload: { objectId: string; stroke: WhiteboardStroke }): void;
  (e: 'clearWhiteboard', payload: { objectId: string }): void;
  (e: 'addNote', payload: { objectId: string; note: StickyNote }): void;
  (e: 'deleteNote', payload: { objectId: string; noteId: string }): void;
  (e: 'makeGameMove', payload: { objectId: string; index: number; symbol: 'X' | 'O' }): void;
  (e: 'resetGame', payload: { objectId: string; game?: GameTableGame }): void;
  (e: 'deskClaim', payload: { objectId: string }): void;
  (e: 'deskRelease', payload: { objectId: string }): void;
  (e: 'deskSettings', payload: { objectId: string; statusNote: string; equipment: DeskEquipment }): void;
}>();

// Whiteboard State
const canvasRef = ref<HTMLCanvasElement | null>(null);
const isDrawing = ref(false);
const color = ref('#ffffff');
const brushWidth = ref(5);
const currentPoints = ref<{ x: number; y: number }[]>([]);

function drawAllStrokes() {
  const canvas = canvasRef.value;
  if (!canvas || !props.object?.data?.whiteboardStrokes) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  props.object.data.whiteboardStrokes.forEach((stroke) => {
    if (stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  });
}

onMounted(() => {
  if (props.object?.type === 'whiteboard') {
    drawAllStrokes();
  }
});

watch(
  () => props.object?.data?.whiteboardStrokes,
  () => {
    if (props.object?.type === 'whiteboard') {
      drawAllStrokes();
    }
  },
  { deep: true }
);

/**
 * Pointer position in *canvas* pixels.
 *
 * The board has a fixed 600x350 backing store but is laid out responsively, so CSS pixels
 * and canvas pixels are only the same unit when the modal happens to be exactly 600 wide -
 * which it never is. Without this scale every stroke lands progressively further from the
 * cursor the further right and further down you draw, and strokes are shared with everyone
 * else, so the offset is baked into what they see too.
 */
function pointerPos(e: PointerEvent) {
  const canvas = canvasRef.value!;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function handleMouseDown(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  // Pointer events rather than mouse events so the board also works by touch and stylus -
  // the canvas already sets touch-none for exactly that, but nothing was listening.
  // Capture keeps a stroke tracking if the cursor leaves the board mid-drag; it throws for a
  // pointer the browser is not tracking, which must not take the whole stroke down with it.
  try {
    canvas.setPointerCapture?.(e.pointerId);
  } catch {}
  isDrawing.value = true;
  currentPoints.value = [pointerPos(e)];
}

function handleMouseMove(e: PointerEvent) {
  if (!isDrawing.value || !canvasRef.value) return;
  const { x, y } = pointerPos(e);
  currentPoints.value.push({ x, y });

  const ctx = canvasRef.value.getContext('2d');
  if (ctx && currentPoints.value.length >= 2) {
    const pts = currentPoints.value;
    ctx.strokeStyle = color.value;
    ctx.lineWidth = brushWidth.value;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
}

function handleMouseUp() {
  if (!isDrawing.value || !props.object) return;
  isDrawing.value = false;
  if (currentPoints.value.length > 0) {
    const stroke: WhiteboardStroke = {
      id: `stroke_${Date.now()}_${Math.random()}`,
      points: [...currentPoints.value],
      color: color.value,
      width: brushWidth.value,
    };
    emit('sendWhiteboardStroke', { objectId: props.object.id, stroke });
  }
  currentPoints.value = [];
}

// Sticky Notes State
const newNoteText = ref('');
const noteColor = ref('#fef08a');

function handleAddNote() {
  if (!newNoteText.value.trim() || !props.object) return;
  const note: StickyNote = {
    id: `note_${Date.now()}_${Math.random()}`,
    author: props.currentUser.name,
    authorId: props.currentUser.id,
    text: newNoteText.value.trim(),
    color: noteColor.value,
    createdAt: Date.now(),
  };
  emit('addNote', { objectId: props.object.id, note });
  newNoteText.value = '';
}

function handleDeleteNote(noteId: string) {
  if (!props.object) return;
  emit('deleteNote', { objectId: props.object.id, noteId });
}

// --- Arcade table ------------------------------------------------------------------
// Board geometry and legality come from lib/gameTable, the same module the server decides
// moves with, so the grid drawn here can never disagree with the rules being enforced.
const gameState = computed(() => normalizeGameState(props.object?.data?.gameState));
const gameSpec = computed(() => specFor(gameState.value.game));

/** For 4-to-Win: the cell a click on this column would actually fill, for the hover preview. */
const previewIndex = ref<number | null>(null);

function handleCellClick(index: number) {
  if (!props.object) return;
  const target = resolveMove(gameState.value, index);
  if (target === null) return;
  emit('makeGameMove', {
    objectId: props.object.id,
    index,
    symbol: gameState.value.turn,
  });
}

function handleCellHover(index: number | null) {
  previewIndex.value = index === null ? null : resolveMove(gameState.value, index);
}

function switchGame(game: GameTableGame) {
  if (!props.object || gameState.value.game === game) return;
  emit('resetGame', { objectId: props.object.id, game });
}

// User Desk State Helpers
const editingDeskNote = ref('');
const deskNoteColor = ref('#fef08a');
const editingStatusNote = ref('');
const editingEquipment = ref<'dual_monitors' | 'laptop' | 'gaming_rig' | 'designer_tablet' | 'keyboard'>('laptop');

watch(
  () => props.object,
  (newObj) => {
    if (newObj?.type === 'desk') {
      const state = newObj.data?.deskState;
      editingStatusNote.value = state?.statusNote || '';
      editingEquipment.value = state?.equipment || 'laptop';
    }
  },
  { immediate: true }
);

function handleClaimDesk() {
  if (!props.object) return;
  // The server derives the claimant from the connection - it will not take a name or id
  // from us - so there is nothing to send but which desk.
  emit('deskClaim', { objectId: props.object.id });
}

function handleUnclaimDesk() {
  if (!props.object) return;
  emit('deskRelease', { objectId: props.object.id });
}

function handleSaveDeskSettings() {
  if (!props.object) return;
  emit('deskSettings', {
    objectId: props.object.id,
    statusNote: editingStatusNote.value,
    equipment: editingEquipment.value,
  });
}

function handleAddDeskStickyNote() {
  if (!editingDeskNote.value.trim() || !props.object) return;
  // Routed through the same addNote path as the bulletin board: appending is the only way to
  // change a desk you do not own, and the server stamps the author.
  const note: StickyNote = {
    id: `desk_note_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    author: props.currentUser.name,
    authorId: props.currentUser.id,
    text: editingDeskNote.value.trim(),
    color: deskNoteColor.value,
    createdAt: Date.now(),
  };
  emit('addNote', { objectId: props.object.id, note });
  editingDeskNote.value = '';
}
</script>

<template>
  <div v-if="object" class="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div class="bg-white border-3 border-slate-900 rounded-2xl shadow-[10px_10px_0px_0px_#0f172a] max-w-2xl w-full text-slate-900 overflow-hidden relative flex flex-col max-h-[85vh]">
      <!-- Modal Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b-2 border-slate-900 bg-amber-100">
        <div class="flex items-center gap-3">
          <div class="p-2 bg-amber-300 text-slate-950 rounded-xl border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]">
            <Sparkles class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-lg font-extrabold text-slate-900 font-heading">{{ object.name }}</h3>
            <p class="text-xs text-slate-700 font-bold capitalize">Interactive {{ object.type.replace('_', ' ') }}</p>
          </div>
        </div>
        <button
          type="button"
          @click="emit('close')"
          class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 border-2 border-slate-900 text-slate-900 transition-colors pixel-btn"
        >
          <X class="w-5 h-5" />
        </button>
      </div>

      <!-- Modal Body -->
      <div class="p-6 overflow-y-auto flex-1 custom-scrollbar">
        <!-- Whiteboard -->
        <template v-if="object.type === 'whiteboard'">
          <div class="flex flex-col gap-4">
            <!-- Wraps rather than overflowing: the two groups are close to the modal's width
                 on their own, so with no wrapping the Eraser ran straight over the "Brush:"
                 label. Buttons are shrink-0 so they reflow to a second line intact instead
                 of being squashed. -->
            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-amber-50 p-3 rounded-xl border-2 border-slate-900">
              <div class="flex items-center flex-wrap gap-2">
                <button
                  v-for="c in ['#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#eab308', '#ec4899']"
                  :key="c"
                  type="button"
                  @click="color = c"
                  :class="`w-7 h-7 shrink-0 rounded-lg border-2 border-slate-900 transition-all ${
                    color === c ? 'scale-110 shadow-[2px_2px_0px_0px_#0f172a] ring-2 ring-amber-400' : ''
                  }`"
                  :style="{ backgroundColor: c }"
                />
                <button
                  type="button"
                  @click="color = '#f8fafc'"
                  :class="`p-1.5 shrink-0 whitespace-nowrap rounded-lg border-2 border-slate-900 text-xs font-bold flex items-center gap-1 pixel-btn ${
                    color === '#f8fafc' ? 'bg-indigo-500 text-white' : 'bg-white text-slate-900'
                  }`"
                >
                  <Eraser class="w-4 h-4" /> Eraser
                </button>
              </div>

              <div class="flex items-center flex-wrap gap-2">
                <span class="text-xs font-bold text-slate-900 font-heading shrink-0">Brush:</span>
                <button
                  v-for="w in [2, 5, 10]"
                  :key="w"
                  type="button"
                  @click="brushWidth = w"
                  :class="`px-2 py-1 shrink-0 text-xs font-bold rounded-lg border-2 border-slate-900 pixel-btn ${
                    brushWidth === w ? 'bg-amber-300 text-slate-950 font-heading shadow-[2px_2px_0px_0px_#0f172a]' : 'bg-white text-slate-900'
                  }`"
                >
                  {{ w }}px
                </button>

                <button
                  type="button"
                  @click="emit('clearWhiteboard', { objectId: object.id })"
                  class="p-1.5 shrink-0 whitespace-nowrap bg-rose-400 hover:bg-rose-500 text-slate-950 border-2 border-slate-900 rounded-lg text-xs font-bold flex items-center gap-1 transition-all pixel-btn"
                >
                  <Trash2 class="w-4 h-4" /> Clear
                </button>
              </div>
            </div>

            <div class="border-3 border-slate-900 rounded-xl overflow-hidden bg-slate-900 shadow-[4px_4px_0px_0px_#0f172a]">
              <canvas
                ref="canvasRef"
                :width="600"
                :height="350"
                @pointerdown="handleMouseDown"
                @pointermove="handleMouseMove"
                @pointerup="handleMouseUp"
                @pointercancel="handleMouseUp"
                class="w-full h-auto cursor-crosshair touch-none"
              />
            </div>
          </div>
        </template>

        <!-- Sticky Notes -->
        <template v-else-if="object.type === 'sticky_notes'">
          <div class="flex flex-col gap-6">
            <form @submit.prevent="handleAddNote" class="bg-amber-50 p-4 rounded-xl border-2 border-slate-900 flex flex-col gap-3 shadow-[3px_3px_0px_0px_#0f172a]">
              <textarea
                v-model="newNoteText"
                placeholder="Write a message, task or notice..."
                class="w-full bg-white border-2 border-slate-900 rounded-lg p-3 text-sm text-slate-900 font-bold placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none h-20 transition-all"
              />
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <button
                    v-for="c in ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa']"
                    :key="c"
                    type="button"
                    @click="noteColor = c"
                    :class="`w-6 h-6 rounded-lg border-2 border-slate-900 transition-all ${
                      noteColor === c ? 'scale-110 shadow-[2px_2px_0px_0px_#0f172a]' : ''
                    }`"
                    :style="{ backgroundColor: c }"
                  />
                </div>
                <button
                  type="submit"
                  class="bg-indigo-500 hover:bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold border-2 border-slate-900 flex items-center gap-1.5 transition-all pixel-btn"
                >
                  <Plus class="w-4 h-4" /> Post Note
                </button>
              </div>
            </form>

            <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <p v-if="!object.data?.notes || object.data.notes.length === 0" class="col-span-full text-center text-slate-500 font-bold py-8 text-sm">
                No notes pinned yet. Be the first to leave one!
              </p>
              <template v-else>
                <div
                  v-for="note in object.data.notes"
                  :key="note.id"
                  class="p-3.5 rounded-xl border-2 border-slate-900 text-slate-900 flex flex-col justify-between min-h-[120px] shadow-[3px_3px_0px_0px_#0f172a] transition-transform hover:-translate-y-1"
                  :style="{ backgroundColor: note.color }"
                >
                  <p class="text-xs font-extrabold leading-snug whitespace-pre-wrap text-slate-900 font-heading">{{ note.text }}</p>
                  <div class="mt-3 pt-2 border-t-2 border-slate-900 flex items-center justify-between gap-1 text-[10px] font-bold text-slate-900">
                    <span class="truncate">— {{ note.author }}</span>
                    <div class="flex items-center gap-1 shrink-0">
                      <span>{{ new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
                      <button
                        v-if="canDeleteNote(currentUser, note)"
                        type="button"
                        @click="handleDeleteNote(note.id)"
                        :title="`Delete this note`"
                        class="p-0.5 rounded border-2 border-slate-900 bg-white/70 hover:bg-rose-400 text-slate-900 transition-colors"
                      >
                        <Trash2 class="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </template>

        <!-- Tic-Tac-Toe Game Table -->
        <template v-else-if="object.type === 'game_table'">
          <div v-if="object.data?.gameState" class="flex flex-col items-center gap-4 py-2">
            <!-- Game picker. Switching restarts the table, so it doubles as the reset. -->
            <div class="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border-2 border-slate-900 w-full max-w-sm">
              <button
                v-for="(spec, key) in GAME_SPECS"
                :key="key"
                type="button"
                @click="switchGame(key as GameTableGame)"
                :class="`flex-1 py-1.5 px-2 text-[11px] font-bold rounded-lg transition-all font-heading ${
                  gameState.game === key
                    ? 'bg-amber-300 text-slate-950 border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]'
                    : 'text-slate-700 hover:text-slate-950'
                }`"
              >
                {{ spec.label }}
              </button>
            </div>

            <div class="flex items-center justify-between w-full max-w-sm bg-amber-50 px-4 py-2.5 rounded-xl border-2 border-slate-900 shadow-[3px_3px_0px_0px_#0f172a]">
              <div class="text-xs font-extrabold font-heading flex items-center gap-2">
                <span v-if="gameState.winner === 'Draw'" class="text-slate-700">It's a Draw!</span>
                <template v-else-if="gameState.winner">
                  <span
                    :class="`w-4 h-4 rounded-full border-2 border-slate-900 ${gameState.winner === 'X' ? 'bg-indigo-500' : 'bg-emerald-400'}`"
                  />
                  <span class="text-emerald-700">Winner! 🎉</span>
                </template>
                <template v-else>
                  <span class="text-slate-900">Turn:</span>
                  <span
                    :class="`w-4 h-4 rounded-full border-2 border-slate-900 ${gameState.turn === 'X' ? 'bg-indigo-500' : 'bg-emerald-400'}`"
                  />
                </template>
              </div>
              <button
                type="button"
                @click="emit('resetGame', { objectId: object.id })"
                class="p-1.5 bg-white border-2 border-slate-900 hover:bg-slate-100 rounded-lg text-xs font-bold text-slate-900 flex items-center gap-1 transition-all pixel-btn font-heading"
              >
                <RotateCcw class="w-3.5 h-3.5" /> Restart
              </button>
            </div>

            <!-- One grid drives both games; only the column count and cell size differ. -->
            <div
              class="grid gap-1.5 sm:gap-2 bg-amber-100 p-3 rounded-2xl border-3 border-slate-900 shadow-[6px_6px_0px_0px_#0f172a]"
              :style="{ gridTemplateColumns: `repeat(${gameSpec.cols}, minmax(0, 1fr))` }"
              @mouseleave="handleCellHover(null)"
            >
              <button
                v-for="(cell, idx) in gameState.board"
                :key="idx"
                type="button"
                @click="handleCellClick(idx)"
                @mouseenter="handleCellHover(idx)"
                :class="`border-2 border-slate-900 font-black flex items-center justify-center transition-all font-press-start ${
                  gameSpec.gravity
                    ? 'w-9 h-9 sm:w-11 sm:h-11 rounded-full'
                    : 'w-20 h-20 text-3xl rounded-xl pixel-btn'
                } ${
                  cell === 'X'
                    ? 'bg-indigo-500 text-white'
                    : cell === 'O'
                    ? 'bg-emerald-400 text-slate-950'
                    : previewIndex === idx
                    ? gameState.turn === 'X'
                      ? 'bg-indigo-200'
                      : 'bg-emerald-200'
                    : 'bg-white text-slate-900 hover:bg-slate-100'
                }`"
              >
                <!-- 4-to-Win reads as discs dropped into holes, so the cell *is* the disc.
                     Noughts and crosses keep their glyphs. -->
                <template v-if="!gameSpec.gravity">{{ cell }}</template>
              </button>
            </div>

            <p v-if="gameSpec.gravity" class="text-[11px] text-slate-600 font-bold text-center">
              Drop four in a row - across, down or diagonally.
            </p>
          </div>
        </template>

                                <!-- Personal User Desk / Workstation Modal -->
        <template v-else-if="object.type === 'desk' || object.type === 'computer'">
          <div class="flex flex-col gap-5 py-2">
            <!-- Desk Ownership Status Banner -->
            <div
              :class="`p-4 rounded-2xl border-3 border-slate-900 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-[4px_4px_0px_0px_#0f172a] ${
                object.data?.deskState?.claimedByUserId ? 'bg-amber-100 text-slate-950' : 'bg-slate-100 text-slate-900'
              }`"
            >
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-xl bg-white border-2 border-slate-900 flex items-center justify-center text-2xl shadow-[2px_2px_0px_0px_#0f172a] shrink-0">
                  {{ object.data?.deskState?.equipment === 'dual_monitors' ? '🖥️' : object.data?.deskState?.equipment === 'gaming_rig' ? '🎮' : '💻' }}
                </div>
                <div>
                  <h4 class="text-sm font-black text-slate-950 font-heading">
                    {{ object.data?.deskState?.deskLabel || object.name }}
                  </h4>
                  <p class="text-xs font-bold text-slate-700 mt-0.5">
                    <template v-if="object.data?.deskState?.claimedByUserName">
                      Occupied by <strong class="text-indigo-950 font-heading">👤 {{ object.data.deskState.claimedByUserName }}</strong>
                    </template>
                    <template v-else>
                      ✨ Unclaimed Workstation — Available for assignment
                    </template>
                  </p>
                </div>
              </div>

              <!-- Claim / Unclaim Action Button -->
              <div class="shrink-0 w-full sm:w-auto">
                <button
                  v-if="!object.data?.deskState?.claimedByUserId"
                  type="button"
                  @click="handleClaimDesk"
                  class="w-full sm:w-auto bg-amber-400 hover:bg-amber-500 text-slate-950 border-2 border-slate-900 px-4 py-2 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 pixel-btn shadow-[2px_2px_0px_0px_#0f172a] font-heading"
                >
                  <UserCheck class="w-4 h-4" /> Claim Desk
                </button>
                <button
                  v-else-if="canManageDesk(currentUser, object.data?.deskState)"
                  type="button"
                  @click="handleUnclaimDesk"
                  class="w-full sm:w-auto bg-rose-200 hover:bg-rose-300 text-rose-950 border-2 border-slate-900 px-3.5 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 pixel-btn font-heading"
                >
                  <UserX class="w-4 h-4" /> Release Desk
                </button>
              </div>
            </div>

            <!-- Current Desk Status / Out of Office Note -->
            <div v-if="object.data?.deskState?.statusNote" class="p-3 bg-white border-2 border-slate-900 rounded-xl shadow-[2px_2px_0px_0px_#0f172a]">
              <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block font-heading mb-0.5">Desk Owner Status</span>
              <p class="text-xs font-bold text-slate-900">{{ object.data.deskState.statusNote }}</p>
            </div>

            <!-- Desk Customization Options (if owned by current user or unclaimed) -->
            <div v-if="canManageDesk(currentUser, object.data?.deskState)" class="p-4 bg-slate-50 border-2 border-slate-900 rounded-2xl flex flex-col gap-3">
              <span class="text-xs font-black text-slate-900 font-heading uppercase tracking-wider">
                ⚙️ Customize Workstation
              </span>

              <div>
                <label class="text-[11px] font-bold text-slate-700 block mb-1">Status Note / Activity</label>
                <input
                  v-model="editingStatusNote"
                  type="text"
                  placeholder="e.g. 💻 Deep Work on WebRTC | 🎧 In a meeting"
                  class="w-full px-3 py-2 bg-white border-2 border-slate-900 rounded-xl text-xs font-bold text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>

              <div>
                <label class="text-[11px] font-bold text-slate-700 block mb-1">Desk Rig & Equipment</label>
                <div class="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    @click="editingEquipment = 'laptop'"
                    :class="`p-2 border-2 border-slate-900 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all pixel-btn ${
                      editingEquipment === 'laptop' ? 'bg-amber-300 text-slate-950 font-heading shadow-[2px_2px_0px_0px_#0f172a]' : 'bg-white text-slate-800'
                    }`"
                  >
                    💻 Laptop
                  </button>
                  <button
                    type="button"
                    @click="editingEquipment = 'dual_monitors'"
                    :class="`p-2 border-2 border-slate-900 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all pixel-btn ${
                      editingEquipment === 'dual_monitors' ? 'bg-amber-300 text-slate-950 font-heading shadow-[2px_2px_0px_0px_#0f172a]' : 'bg-white text-slate-800'
                    }`"
                  >
                    🖥️ Dual Screen
                  </button>
                  <button
                    type="button"
                    @click="editingEquipment = 'gaming_rig'"
                    :class="`p-2 border-2 border-slate-900 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all pixel-btn ${
                      editingEquipment === 'gaming_rig' ? 'bg-amber-300 text-slate-950 font-heading shadow-[2px_2px_0px_0px_#0f172a]' : 'bg-white text-slate-800'
                    }`"
                  >
                    🎮 RGB Rig
                  </button>
                </div>
              </div>

              <button
                type="button"
                @click="handleSaveDeskSettings"
                class="mt-1 w-full bg-slate-900 hover:bg-slate-800 text-white font-heading text-xs font-extrabold py-2 px-4 rounded-xl border-2 border-slate-900 pixel-btn shadow-[2px_2px_0px_0px_#0f172a]"
              >
                Save Desk Settings
              </button>
            </div>

            <!-- Desk Sticky Notes / Messages from Coworkers -->
            <div class="flex flex-col gap-2.5">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-900 font-heading uppercase tracking-wider flex items-center gap-1.5">
                  <StickyIcon class="w-4 h-4 text-amber-600" /> Desk Notes ({{ object.data?.deskState?.stickyNotes?.length || 0 }})
                </span>
              </div>

              <!-- New Desk Note Form -->
              <div class="flex items-center gap-2">
                <input
                  v-model="editingDeskNote"
                  type="text"
                  placeholder="Leave a quick desk note..."
                  @keyup.enter="handleAddDeskStickyNote"
                  class="flex-1 px-3 py-2 bg-slate-50 border-2 border-slate-900 rounded-xl text-xs font-bold text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
                <button
                  type="button"
                  @click="handleAddDeskStickyNote"
                  class="bg-amber-400 hover:bg-amber-500 text-slate-950 border-2 border-slate-900 p-2 rounded-xl text-xs font-extrabold pixel-btn shadow-[2px_2px_0px_0px_#0f172a]"
                >
                  <Plus class="w-4 h-4" />
                </button>
              </div>

              <!-- List of Sticky Notes on this Desk -->
              <div v-if="object.data?.deskState?.stickyNotes?.length" class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1 max-h-48 overflow-y-auto pr-1">
                <div
                  v-for="note in object.data.deskState.stickyNotes"
                  :key="note.id"
                  class="p-3 bg-amber-100 border-2 border-slate-900 rounded-xl flex flex-col justify-between shadow-[2px_2px_0px_0px_#0f172a]"
                >
                  <p class="text-xs font-extrabold text-slate-950 font-heading whitespace-pre-wrap">{{ note.text }}</p>
                  <div class="mt-2 pt-1 border-t border-slate-900/30 flex items-center justify-between gap-1 text-[10px] font-bold text-slate-700">
                    <span class="truncate">— {{ note.author }}</span>
                    <div class="flex items-center gap-1 shrink-0">
                      <span>{{ new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
                      <button
                        v-if="canDeleteNote(currentUser, note, object.data?.deskState)"
                        type="button"
                        @click="handleDeleteNote(note.id)"
                        title="Delete this note"
                        class="p-0.5 rounded border-2 border-slate-900 bg-white/70 hover:bg-rose-400 text-slate-900 transition-colors"
                      >
                        <Trash2 class="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="p-3 bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl text-xs text-slate-500 font-semibold text-center">
                No desk sticky notes yet. Be the first to leave a message!
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
