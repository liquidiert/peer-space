<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { ShieldCheck, X, Plus, Trash2 } from "lucide-vue-next";
import type { Socket } from "socket.io-client";
import type { AdminSource } from "../lib/admins";

interface AdminEntry {
    email: string;
    source: AdminSource;
}

interface AdminAck {
    ok: boolean;
    error?: string;
    admins?: AdminEntry[];
}

const props = defineProps<{
    socket: Socket | null;
    currentEmail?: string;
}>();

const emit = defineEmits<{
    (e: "close"): void;
}>();

const admins = ref<AdminEntry[]>([]);
const loading = ref(true);
const pending = ref(false);
const error = ref<string | null>(null);
const newEmail = ref("");

/** Sends an admin:* event. A successful ack replaces the list with the server's copy. */
function send(
    event: "admin:list" | "admin:grant" | "admin:revoke",
    payload: Record<string, unknown>,
) {
    // Without a socket there is nothing to send; the watcher below retries once one appears.
    if (!props.socket) return;
    pending.value = true;
    error.value = null;
    props.socket.emit(event, payload, (r: AdminAck) => {
        pending.value = false;
        loading.value = false;
        if (r?.ok) {
            if (r.admins) admins.value = r.admins;
            if (event === "admin:grant") newEmail.value = "";
        } else {
            error.value = r?.error || "Request failed.";
        }
    });
}

function addAdmin() {
    const email = newEmail.value.trim();
    if (!email || pending.value) return;
    send("admin:grant", { email });
}

function removeAdmin(email: string) {
    if (pending.value) return;
    send("admin:revoke", { email });
}

onMounted(() => {
    send("admin:list", {});
});

// The socket may not be connected yet when this mounts; load once it appears.
watch(
    () => props.socket,
    (socket) => {
        if (socket && loading.value) send("admin:list", {});
    },
);
</script>

<template>
    <div
        class="w-full max-w-md bg-white border-3 border-slate-900 rounded-2xl shadow-[6px_6px_0px_0px_#0f172a] text-slate-900 flex flex-col overflow-hidden"
    >
        <!-- Header Bar -->
        <div
            class="flex items-center justify-between px-3 py-2 bg-slate-900 text-white border-b-2 border-slate-900 select-none"
        >
            <div class="flex items-center gap-2">
                <ShieldCheck class="w-4 h-4 text-amber-400" />
                <span class="font-extrabold text-xs font-heading tracking-wide"
                    >Manage Admins</span
                >
            </div>
            <button
                type="button"
                @click="emit('close')"
                class="p-1 rounded text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                title="Close"
            >
                <X class="w-4 h-4" />
            </button>
        </div>

        <div class="p-3 flex flex-col gap-2.5 bg-slate-50 max-h-[70vh] overflow-y-auto custom-scrollbar">
            <p
                v-if="error"
                class="text-[11px] font-extrabold text-rose-700 bg-rose-100 border-2 border-slate-900 rounded-xl p-2"
            >
                {{ error }}
            </p>

            <p
                v-if="loading"
                class="text-[11px] font-bold text-slate-600 text-center py-4"
            >
                Loading admins…
            </p>

            <p
                v-else-if="admins.length === 0"
                class="text-[11px] font-bold text-slate-700 text-center bg-amber-100 border-2 border-slate-900 rounded-xl p-3"
            >
                No admins yet.
            </p>

            <div
                v-for="admin in admins"
                :key="admin.email"
                class="p-2.5 bg-white border-2 border-slate-900 rounded-xl flex items-center justify-between gap-2 text-xs shadow-[2px_2px_0px_0px_#0f172a]"
            >
                <div class="flex items-center gap-1.5 min-w-0">
                    <span class="font-bold truncate" :title="admin.email">{{
                        admin.email
                    }}</span>
                    <span
                        v-if="admin.email === currentEmail?.toLowerCase()"
                        class="text-[10px] text-indigo-700 font-bold font-heading shrink-0"
                        >(YOU)</span
                    >
                </div>

                <span
                    v-if="admin.source === 'env'"
                    title="Set in ADMIN_EMAILS; can't be removed here"
                    class="bg-slate-200 text-slate-700 border border-slate-900 px-1.5 py-0.5 rounded text-[9px] font-black uppercase shrink-0"
                    >config</span
                >
                <button
                    v-else
                    type="button"
                    @click="removeAdmin(admin.email)"
                    :disabled="pending"
                    :class="`text-[10px] font-bold px-2 py-1 rounded-lg border-2 border-slate-900 flex items-center gap-1 transition-all pixel-btn shrink-0 ${
                        pending
                            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                            : 'bg-rose-200 hover:bg-rose-300 text-slate-950'
                    }`"
                >
                    <Trash2 class="w-3 h-3" /> Remove
                </button>
            </div>

            <form
                @submit.prevent="addAdmin"
                class="flex gap-2 pt-1 border-t-2 border-slate-900 mt-1"
            >
                <input
                    type="email"
                    v-model="newEmail"
                    :disabled="pending"
                    placeholder="admin@example.com"
                    class="flex-1 min-w-0 bg-white border-2 border-slate-900 rounded-lg px-3 py-1.5 text-xs text-slate-900 placeholder-slate-500 font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 transition-all disabled:opacity-60"
                />
                <button
                    type="submit"
                    :disabled="pending || !newEmail.trim()"
                    :class="`text-[10px] font-bold px-2.5 py-1.5 rounded-lg border-2 border-slate-900 flex items-center gap-1 transition-all pixel-btn shrink-0 font-heading ${
                        pending || !newEmail.trim()
                            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                            : 'bg-amber-300 hover:bg-amber-400 text-slate-950'
                    }`"
                >
                    <Plus class="w-3.5 h-3.5" /> Add admin
                </button>
            </form>
        </div>
    </div>
</template>
