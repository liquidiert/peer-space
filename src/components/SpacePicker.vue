<script setup lang="ts">
import { ref } from "vue";
import { Sparkles, Plus, Settings, Trash2, Users } from "lucide-vue-next";
import type { SpaceSummary } from "../types";

defineProps<{
    spaces: SpaceSummary[];
    isAdmin: boolean;
    loading: boolean;
    error: string | null;
}>();

const emit = defineEmits<{
    (e: "join", spaceId: string): void;
    (
        e: "create",
        payload: { name: string; memberEmails: string[]; openToAll: boolean },
    ): void;
    (
        e: "update",
        payload: {
            spaceId: string;
            name: string;
            memberEmails: string[];
            openToAll: boolean;
        },
    ): void;
    (e: "delete", spaceId: string): void;
}>();

// One editor at a time: "new" for the create form, otherwise the id of the space being edited.
const editing = ref<string | null>(null);
const draftName = ref("");
const draftEmails = ref("");
const draftOpen = ref(false);

function parseEmails(text: string): string[] {
    return text
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean);
}

function startCreate() {
    editing.value = "new";
    draftName.value = "";
    draftEmails.value = "";
    draftOpen.value = false;
}

function startEdit(space: SpaceSummary) {
    editing.value = space.id;
    draftName.value = space.name;
    draftEmails.value = (space.memberEmails ?? []).join("\n");
    draftOpen.value = !!space.openToAll;
}

function save() {
    const payload = {
        name: draftName.value.trim(),
        memberEmails: parseEmails(draftEmails.value),
        openToAll: draftOpen.value,
    };
    if (!payload.name) return;
    if (editing.value === "new") emit("create", payload);
    else if (editing.value) emit("update", { spaceId: editing.value, ...payload });
    editing.value = null;
}

function remove(space: SpaceSummary) {
    if (window.confirm(`Delete "${space.name}" and all of its maps?`)) {
        emit("delete", space.id);
    }
}
</script>

<template>
    <div class="w-full flex flex-col gap-2.5 text-left">
        <p class="text-xs font-extrabold text-slate-900 font-heading text-center">
            Choose a space
        </p>

        <p v-if="loading" class="text-[11px] font-bold text-slate-600 text-center">
            Loading spaces…
        </p>
        <p
            v-else-if="error"
            class="text-[11px] font-extrabold text-rose-700 text-center"
        >
            {{ error }}
        </p>
        <p
            v-else-if="spaces.length === 0"
            class="text-[11px] font-bold text-slate-700 text-center bg-amber-100 border-2 border-slate-900 rounded-xl p-3"
        >
            You have not been assigned to any space yet. Ask an admin to add
            your email address to one.
        </p>

        <div
            v-for="space in spaces"
            :key="space.id"
            class="flex items-center gap-2"
        >
            <button
                type="button"
                @click="emit('join', space.id)"
                class="flex-1 min-w-0 bg-indigo-500 hover:bg-indigo-600 text-white px-4 py-3 rounded-xl text-xs font-black border-2 border-slate-900 flex items-center justify-between gap-2 cursor-pointer pixel-btn shadow-[3px_3px_0px_0px_#0f172a]"
            >
                <span class="flex items-center gap-2 min-w-0">
                    <Sparkles class="w-4 h-4 shrink-0" />
                    <span class="truncate">{{ space.name }}</span>
                </span>
                <span
                    class="flex items-center gap-1 text-[10px] font-bold shrink-0"
                    :title="`${space.onlineCount} online`"
                >
                    <Users class="w-3 h-3" /> {{ space.onlineCount }}
                </span>
            </button>
            <template v-if="isAdmin">
                <button
                    type="button"
                    title="Edit space"
                    @click="startEdit(space)"
                    class="p-2 bg-slate-100 hover:bg-slate-200 rounded-lg border-2 border-slate-900 pixel-btn"
                >
                    <Settings class="w-4 h-4" />
                </button>
                <button
                    type="button"
                    title="Delete space"
                    @click="remove(space)"
                    class="p-2 bg-rose-200 hover:bg-rose-300 rounded-lg border-2 border-slate-900 pixel-btn"
                >
                    <Trash2 class="w-4 h-4" />
                </button>
            </template>
        </div>

        <template v-if="isAdmin">
            <button
                v-if="!editing"
                type="button"
                @click="startCreate"
                class="bg-amber-300 hover:bg-amber-400 text-slate-950 px-4 py-2.5 rounded-xl text-xs font-black border-2 border-slate-900 flex items-center justify-center gap-2 cursor-pointer pixel-btn shadow-[3px_3px_0px_0px_#0f172a]"
            >
                <Plus class="w-4 h-4" /> New space
            </button>

            <form
                v-else
                @submit.prevent="save"
                class="flex flex-col gap-2 bg-amber-100 border-2 border-slate-900 rounded-xl p-3"
            >
                <p class="text-[11px] font-black text-slate-900 font-heading uppercase">
                    {{ editing === "new" ? "New space" : "Edit space" }}
                </p>
                <input
                    v-model="draftName"
                    maxlength="60"
                    placeholder="Space name"
                    class="px-3 py-2 rounded-lg border-2 border-slate-900 text-xs font-bold bg-white"
                />
                <label class="text-[10px] font-bold text-slate-700">
                    Assigned users (email addresses, one per line)
                </label>
                <textarea
                    v-model="draftEmails"
                    rows="4"
                    placeholder="alex@example.com"
                    class="px-3 py-2 rounded-lg border-2 border-slate-900 text-xs font-semibold bg-white resize-y"
                />
                <label class="flex items-center gap-2 text-[11px] font-bold text-slate-900">
                    <input v-model="draftOpen" type="checkbox" />
                    Open to everyone who can sign in
                </label>
                <div class="flex gap-2">
                    <button
                        type="submit"
                        class="flex-1 bg-emerald-400 hover:bg-emerald-500 px-3 py-2 rounded-lg border-2 border-slate-900 text-xs font-black pixel-btn"
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        @click="editing = null"
                        class="flex-1 bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg border-2 border-slate-900 text-xs font-black pixel-btn"
                    >
                        Cancel
                    </button>
                </div>
            </form>
        </template>
    </div>
</template>
