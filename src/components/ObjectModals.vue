<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import {
  Sparkles,
  X,
  Eraser,
  Trash2,
  Plus,
  RotateCcw,
  Music,
  Pause,
  Play,
  Monitor,
  UserCheck,
  UserX,
  StickyNote as StickyIcon,
} from 'lucide-vue-next';
import type { MapObject, User, WhiteboardStroke, StickyNote, DeskState } from '../types';

const props = defineProps<{
  object: MapObject | null;
  currentUser: User;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'sendWhiteboardStroke', payload: { objectId: string; stroke: WhiteboardStroke }): void;
  (e: 'clearWhiteboard', payload: { objectId: string }): void;
  (e: 'addNote', payload: { objectId: string; note: StickyNote }): void;
  (e: 'makeGameMove', payload: { objectId: string; index: number; symbol: 'X' | 'O' }): void;
  (e: 'resetGame', payload: { objectId: string }): void;
  (e: 'updateDesk', payload: { objectId: string; deskState: DeskState }): void;
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

function handleMouseDown(e: MouseEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  isDrawing.value = true;
  currentPoints.value = [{ x, y }];
}

function handleMouseMove(e: MouseEvent) {
  if (!isDrawing.value || !canvasRef.value) return;
  const rect = canvasRef.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
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
    text: newNoteText.value.trim(),
    color: noteColor.value,
    createdAt: Date.now(),
  };
  emit('addNote', { objectId: props.object.id, note });
  newNoteText.value = '';
}

// Tic-Tac-Toe Game State
function handleCellClick(index: number) {
  if (!props.object?.data?.gameState) return;
  const state = props.object.data.gameState;
  if (state.board[index] !== null || state.winner) return;
  emit('makeGameMove', {
    objectId: props.object.id,
    index,
    symbol: state.turn,
  });
}

// Jukebox State
const isPlaying = ref(false);
const currentTrack = ref(0);
const TRACKS = [
  { title: 'Chill Lo-Fi Beats', duration: '2:45' },
  { title: 'Ambient Office Lounge', duration: '3:10' },
  { title: 'Focus Deep Flow', duration: '4:15' },
];

// Espresso Coffee State
const brewing = ref(false);
function handleBrew() {
  brewing.value = true;
  setTimeout(() => {
    brewing.value = false;
  }, 2000);
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
  const currentDeskState = props.object.data?.deskState || {};
  const updatedState: DeskState = {
    ...currentDeskState,
    claimedByUserId: props.currentUser.id,
    claimedByUserName: props.currentUser.name,
    deskLabel: `${props.currentUser.name}'s Desk`,
    statusNote: currentDeskState.statusNote || '💻 Working at my desk',
    equipment: editingEquipment.value,
  };
  emit('updateDesk', { objectId: props.object.id, deskState: updatedState });
}

function handleUnclaimDesk() {
  if (!props.object) return;
  const currentDeskState = props.object.data?.deskState || {};
  const updatedState: DeskState = {
    ...currentDeskState,
    claimedByUserId: undefined,
    claimedByUserName: undefined,
    deskLabel: 'Unassigned Desk',
    statusNote: '',
  };
  emit('updateDesk', { objectId: props.object.id, deskState: updatedState });
}

function handleSaveDeskSettings() {
  if (!props.object) return;
  const currentDeskState = props.object.data?.deskState || {};
  const updatedState: DeskState = {
    ...currentDeskState,
    statusNote: editingStatusNote.value,
    equipment: editingEquipment.value,
  };
  emit('updateDesk', { objectId: props.object.id, deskState: updatedState });
}

function handleAddDeskStickyNote() {
  if (!editingDeskNote.value.trim() || !props.object) return;
  const currentDeskState = props.object.data?.deskState || {};
  const existingNotes = currentDeskState.stickyNotes || [];
  const note: StickyNote = {
    id: `desk_note_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    author: props.currentUser.name,
    text: editingDeskNote.value.trim(),
    color: deskNoteColor.value,
    createdAt: Date.now(),
  };

  const updatedState: DeskState = {
    ...currentDeskState,
    stickyNotes: [note, ...existingNotes],
  };
  emit('updateDesk', { objectId: props.object.id, deskState: updatedState });
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
            <div class="flex items-center justify-between bg-amber-50 p-3 rounded-xl border-2 border-slate-900">
              <div class="flex items-center gap-2">
                <button
                  v-for="c in ['#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#eab308', '#ec4899']"
                  :key="c"
                  type="button"
                  @click="color = c"
                  :class="`w-7 h-7 rounded-lg border-2 border-slate-900 transition-all ${
                    color === c ? 'scale-110 shadow-[2px_2px_0px_0px_#0f172a] ring-2 ring-amber-400' : ''
                  }`"
                  :style="{ backgroundColor: c }"
                />
                <button
                  type="button"
                  @click="color = '#f8fafc'"
                  :class="`p-1.5 rounded-lg border-2 border-slate-900 text-xs font-bold flex items-center gap-1 pixel-btn ${
                    color === '#f8fafc' ? 'bg-indigo-500 text-white' : 'bg-white text-slate-900'
                  }`"
                >
                  <Eraser class="w-4 h-4" /> Eraser
                </button>
              </div>

              <div class="flex items-center gap-3">
                <span class="text-xs font-bold text-slate-900 font-heading">Brush:</span>
                <button
                  v-for="w in [2, 5, 10]"
                  :key="w"
                  type="button"
                  @click="brushWidth = w"
                  :class="`px-2 py-1 text-xs font-bold rounded-lg border-2 border-slate-900 pixel-btn ${
                    brushWidth === w ? 'bg-amber-300 text-slate-950 font-heading shadow-[2px_2px_0px_0px_#0f172a]' : 'bg-white text-slate-900'
                  }`"
                >
                  {{ w }}px
                </button>

                <button
                  type="button"
                  @click="emit('clearWhiteboard', { objectId: object.id })"
                  class="p-1.5 bg-rose-400 hover:bg-rose-500 text-slate-950 border-2 border-slate-900 rounded-lg text-xs font-bold flex items-center gap-1 transition-all pixel-btn"
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
                @mousedown="handleMouseDown"
                @mousemove="handleMouseMove"
                @mouseup="handleMouseUp"
                @mouseleave="handleMouseUp"
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
                  <div class="mt-3 pt-2 border-t-2 border-slate-900 flex items-center justify-between text-[10px] font-bold text-slate-900">
                    <span>— {{ note.author }}</span>
                    <span>{{ new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </template>

        <!-- Tic-Tac-Toe Game Table -->
        <template v-else-if="object.type === 'game_table'">
          <div v-if="object.data?.gameState" class="flex flex-col items-center gap-6 py-2">
            <div class="flex items-center justify-between w-full max-w-xs bg-amber-50 px-4 py-2.5 rounded-xl border-2 border-slate-900 shadow-[3px_3px_0px_0px_#0f172a]">
              <div class="text-xs font-extrabold font-heading">
                <span v-if="object.data.gameState.winner" class="text-emerald-700">
                  {{ object.data.gameState.winner === 'Draw' ? "It's a Draw!" : `Winner: ${object.data.gameState.winner}! 🎉` }}
                </span>
                <span v-else class="text-slate-900">
                  Turn: <strong class="text-indigo-600 font-heading">{{ object.data.gameState.turn }}</strong>
                </span>
              </div>
              <button
                type="button"
                @click="emit('resetGame', { objectId: object.id })"
                class="p-1.5 bg-white border-2 border-slate-900 hover:bg-slate-100 rounded-lg text-xs font-bold text-slate-900 flex items-center gap-1 transition-all pixel-btn font-heading"
              >
                <RotateCcw class="w-3.5 h-3.5" /> Restart
              </button>
            </div>

            <div class="grid grid-cols-3 gap-3 bg-amber-100 p-4 rounded-2xl border-3 border-slate-900 shadow-[6px_6px_0px_0px_#0f172a]">
              <button
                v-for="(cell, idx) in object.data.gameState.board"
                :key="idx"
                type="button"
                @click="handleCellClick(idx)"
                :class="`w-20 h-20 rounded-xl border-2 border-slate-900 font-black text-3xl flex items-center justify-center transition-all pixel-btn font-press-start ${
                  cell === 'X'
                    ? 'bg-indigo-500 text-white shadow-[2px_2px_0px_0px_#0f172a]'
                    : cell === 'O'
                    ? 'bg-emerald-400 text-slate-950 shadow-[2px_2px_0px_0px_#0f172a]'
                    : 'bg-white text-slate-900 hover:bg-slate-100'
                }`"
              >
                {{ cell }}
              </button>
            </div>
          </div>
        </template>

        <!-- Jukebox Radio -->
        <template v-else-if="object.type === 'jukebox'">
          <div class="flex flex-col items-center gap-6 py-4">
            <div class="w-24 h-24 rounded-2xl bg-indigo-500 border-3 border-slate-900 flex items-center justify-center shadow-[6px_6px_0px_0px_#0f172a] animate-bounce">
              <Music class="w-10 h-10 text-white" />
            </div>

            <div class="text-center">
              <h4 class="text-lg font-extrabold text-slate-900 font-heading">{{ TRACKS[currentTrack].title }}</h4>
              <p class="text-xs text-indigo-700 font-bold mt-1">Retro Pixel Jukebox</p>
            </div>

            <div class="flex items-center gap-4">
              <button
                type="button"
                @click="isPlaying = !isPlaying"
                class="w-12 h-12 rounded-xl bg-amber-300 hover:bg-amber-400 border-2 border-slate-900 text-slate-950 flex items-center justify-center transition-all pixel-btn shadow-[3px_3px_0px_0px_#0f172a]"
              >
                <Pause v-if="isPlaying" class="w-6 h-6 text-slate-900" />
                <Play v-else class="w-6 h-6 text-slate-900 ml-0.5" />
              </button>
            </div>

            <div class="w-full bg-amber-50 rounded-xl p-4 border-2 border-slate-900 flex flex-col gap-2 shadow-[3px_3px_0px_0px_#0f172a]">
              <span class="text-xs font-bold text-slate-900 uppercase tracking-wider font-heading">Playlist</span>
              <button
                v-for="(track, idx) in TRACKS"
                :key="idx"
                type="button"
                @click="() => {
                  currentTrack = idx;
                  isPlaying = true;
                }"
                :class="`w-full p-3 rounded-lg text-left text-xs flex items-center justify-between border-2 border-slate-900 transition-all pixel-btn font-bold ${
                  currentTrack === idx
                    ? 'bg-amber-300 text-slate-950 font-heading shadow-[2px_2px_0px_0px_#0f172a]'
                    : 'bg-white text-slate-900 hover:bg-slate-100'
                }`"
              >
                <span>{{ track.title }}</span>
                <span class="font-heading">{{ track.duration }}</span>
              </button>
            </div>
          </div>
        </template>

        <!-- TV Presentation Screen -->
        <template v-else-if="object.type === 'tv'">
          <div class="flex flex-col gap-4">
            <div class="aspect-video w-full rounded-xl overflow-hidden bg-black border-3 border-slate-900 shadow-[6px_6px_0px_0px_#0f172a]">
              <iframe
                :src="object.data?.videoUrl || 'https://www.youtube.com/embed/jfKfPfyJRdk'"
                title="Presentation Screen"
                class="w-full h-full"
                allowFullScreen
              />
            </div>
            <p class="text-xs text-slate-700 font-bold text-center">
              Everyone standing near the Presentation Screen sees this media broadcast.
            </p>
          </div>
        </template>

        <!-- Coffee Espresso Machine -->
        <template v-else-if="object.type === 'coffee_machine'">
          <div class="flex flex-col items-center gap-5 py-6 text-center">
            <div class="w-20 h-20 bg-amber-200 rounded-2xl flex items-center justify-center text-4xl border-3 border-slate-900 shadow-[4px_4px_0px_0px_#0f172a]">☕</div>
            <h4 class="text-lg font-extrabold text-slate-900 font-heading">Fresh Espresso Station</h4>
            <p class="text-xs text-slate-700 font-bold max-w-sm leading-relaxed">
              Take a break from work and grab a hot espresso before your next team meeting.
            </p>
            <button
              type="button"
              @click="handleBrew"
              class="bg-amber-300 hover:bg-amber-400 border-2 border-slate-900 text-slate-950 px-6 py-3 rounded-xl font-bold text-xs transition-all pixel-btn font-heading"
            >
              {{ brewing ? 'Brewing Espresso... ☕' : 'Brew Hot Coffee' }}
            </button>
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
                  v-else-if="object.data?.deskState?.claimedByUserId === currentUser.id"
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
            <div v-if="!object.data?.deskState?.claimedByUserId || object.data?.deskState?.claimedByUserId === currentUser.id" class="p-4 bg-slate-50 border-2 border-slate-900 rounded-2xl flex flex-col gap-3">
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
                  <div class="mt-2 pt-1 border-t border-slate-900/30 flex items-center justify-between text-[10px] font-bold text-slate-700">
                    <span>— {{ note.author }}</span>
                    <span>{{ new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
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
