<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { io, Socket } from 'socket.io-client';
import SpatialCanvas from './components/SpatialCanvas.vue';
import ControlBar from './components/ControlBar.vue';
import ProximityChatPanel from './components/ProximityChatPanel.vue';
import MapBuilderDrawer from './components/MapBuilderDrawer.vue';
import MiniMap from './components/MiniMap.vue';
import AvatarBuilder from './components/AvatarBuilder.vue';
import ObjectModals from './components/ObjectModals.vue';
import VideoDock from './components/VideoDock.vue';
import { Sparkles, Compass, LogIn, CheckCircle2, LogOut, ShieldCheck, Hammer } from 'lucide-vue-next';
import type {
  User,
  GridMap,
  ChatMessage,
  MapObject,
  TileType,
  AvatarCustomization,
  WhiteboardStroke,
  StickyNote,
} from './types';
import { createDefaultOfficeMap } from './mapsData';
import { useWebRTCProximity } from './composables/useWebRTCProximity';
import { findPathAStar } from './lib/pathfinding';

const socket = ref<Socket | null>(null);
const hasJoined = ref(false);
const userNameInput = ref('');

const AUTH_USER_PERSISTENCE_KEY = 'peerspace_auth_user';
const AVATAR_PERSISTENCE_KEY = 'peerspace_avatar_config';
const USER_NAME_PERSISTENCE_KEY = 'peerspace_user_name';
const CLIENT_ID_PERSISTENCE_KEY = 'peerspace_client_id';

// A user's socket.id (and therefore the old `user.id`) is re-generated on every reload,
// so anything keyed by it - like a claimed desk's claimedByUserId - would silently stop
// matching the "same" user after a refresh. This stable id survives reloads instead.
function getOrCreateClientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_ID_PERSISTENCE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_PERSISTENCE_KEY, id);
    }
    return id;
  } catch (e) {
    return crypto.randomUUID();
  }
}
const clientId = getOrCreateClientId();

function loadSavedAuthUser() {
  try {
    const saved = localStorage.getItem(AUTH_USER_PERSISTENCE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Entries cached before session tokens existed (or ones missing it for any other
      // reason) can't be verified server-side, so isAdmin would silently come back false
      // even for a real admin. Drop them instead of restoring a half-authenticated state -
      // the user just needs to log in again to get a fresh, verifiable token.
      if (parsed && typeof parsed === 'object' && parsed.name && parsed.sessionToken) {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

const authenticatedUser = ref<{ name: string; email?: string; isAdmin?: boolean; sessionToken?: string } | null>(
  loadSavedAuthUser()
);

watch(
  authenticatedUser,
  (newVal) => {
    try {
      if (newVal) {
        localStorage.setItem(AUTH_USER_PERSISTENCE_KEY, JSON.stringify(newVal));
      } else {
        localStorage.removeItem(AUTH_USER_PERSISTENCE_KEY);
      }
    } catch (e) {}
  },
  { deep: true }
);

// Handle Keycloak / Google Social Login Popup
async function handleKeycloakLogin(idp = 'google') {
  try {
    const origin = window.location.origin;
    const redirectUri = `${origin}/auth/callback`;
    const res = await fetch(`/api/auth/login-url?idp=${idp}&origin=${encodeURIComponent(origin)}&redirect_uri=${encodeURIComponent(redirectUri)}`);
    const data = await res.json();

    if (!data.url) {
      alert('Could not construct login URL.');
      return;
    }

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;

    const popup = window.open(
      data.url,
      'keycloak_oauth_popup',
      `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes`
    );

    if (!popup) {
      alert('Please allow popups to log in via Google / Keycloak.');
    }
  } catch (err) {
    console.error('Failed to launch Keycloak login:', err);
  }
}

function handleLogout() {
  authenticatedUser.value = null;
  userNameInput.value = '';
  try {
    localStorage.removeItem(AUTH_USER_PERSISTENCE_KEY);
    localStorage.removeItem(USER_NAME_PERSISTENCE_KEY);
  } catch (e) {}
}

function loadSavedAvatar(): AvatarCustomization {
  const defaultAvatar: AvatarCustomization = {
    skinColor: '#f87171',
    hairStyle: 'short',
    hairColor: '#1e293b',
    outfitColor: '#3b82f6',
    glasses: false,
    hatStyle: 'none',
    statusEmoji: '👋',
  };

  try {
    const saved = localStorage.getItem(AVATAR_PERSISTENCE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object') {
        return { ...defaultAvatar, ...parsed };
      }
    }
  } catch (e) {
    console.warn('Failed to load avatar from browser storage:', e);
  }
  return defaultAvatar;
}

const avatarConfig = ref<AvatarCustomization>(loadSavedAvatar());

watch(
  avatarConfig,
  (newVal) => {
    try {
      localStorage.setItem(AVATAR_PERSISTENCE_KEY, JSON.stringify(newVal));
      if (hasJoined.value && socket.value) {
        currentUser.value.avatar = newVal;
        socket.value.emit('user:update_profile', { avatar: newVal });
      }
    } catch (e) {
      console.warn('Failed to persist avatar to browser storage:', e);
    }
  },
  { deep: true }
);

const currentUser = ref<User>({
  id: '',
  socketId: '',
  name: 'Guest',
  position: { x: 8, y: 8 },
  direction: 'down',
  avatar: avatarConfig.value,
  isMuted: false,
  isDeafened: false,
  isSpeaking: false,
  isScreenSharing: false,
  currentZoneId: null,
  lastSeen: Date.now(),
});

const users = ref<User[]>([]);
const currentMap = ref<GridMap>(createDefaultOfficeMap());
const messages = ref<ChatMessage[]>([]);

// Chat Panel visibility & unread tracking
const isChatOpen = ref(false);
const unreadChatCount = ref(0);

watch(
  () => messages.value.length,
  (newLen, oldLen) => {
    if (newLen > oldLen && !isChatOpen.value) {
      unreadChatCount.value += newLen - oldLen;
    }
  }
);

function handleToggleChat() {
  isChatOpen.value = !isChatOpen.value;
  if (isChatOpen.value) {
    unreadChatCount.value = 0;
  }
}

// Audio & Controls
const isMuted = ref(false);
const isDeafened = ref(false);

const {
  initLocalAudio,
  toggleCamera,
  switchCamera,
  toggleScreenShare,
  handleSignal,
  syncPeerConnections,
  isVideoOn,
  isScreenSharing,
  localVideoStream,
  remoteVideoStreams,
  localScreenStream,
  remoteScreenStreams,
  availableVideoDevices,
} = useWebRTCProximity(socket, currentUser, users, isMuted, isDeafened);

// Map Builder State
const builderMode = ref(false);
const builderAction = ref<'place' | 'erase'>('place');
const selectedTile = ref<TileType>('floor_wood');
const selectedObject = ref<MapObject | null>(null);

// Modal UI State
const activeObjectModal = ref<MapObject | null>(null);
const showAvatarBuilderModal = ref(false);

onMounted(() => {
  try {
    const savedName = localStorage.getItem(USER_NAME_PERSISTENCE_KEY);
    if (savedName && !userNameInput.value) {
      userNameInput.value = savedName;
    }
  } catch (e) {}

  const sk = io();
  socket.value = sk;

  sk.on('init:state', (data: { currentUser: User; currentMap: GridMap; users: User[] }) => {
    currentUser.value = data.currentUser;
    currentMap.value = data.currentMap;
    users.value = data.users;
    syncPeerConnections();
  });

  sk.on('user:joined', (user: User) => {
    users.value = [...users.value.filter((u) => u.socketId !== user.socketId), user];
    syncPeerConnections();
  });

  sk.on('user:left', (socketId: string) => {
    users.value = users.value.filter((u) => u.socketId !== socketId);
    syncPeerConnections();
  });

  sk.on('webrtc:signal', (data: { from: string; signal: any }) => {
    handleSignal(data);
  });

  sk.on(
    'user:moved',
    (data: { userId: string; position: { x: number; y: number }; direction: any; currentZoneId: string | null }) => {
      if (data.userId === currentUser.value.socketId) {
        currentUser.value = {
          ...currentUser.value,
          position: data.position,
          direction: data.direction,
          currentZoneId: data.currentZoneId,
        };
      }
      users.value = users.value.map((u) => {
        if (u.socketId === data.userId) {
          return {
            ...u,
            position: data.position,
            direction: data.direction,
            currentZoneId: data.currentZoneId,
          };
        }
        return u;
      });
    }
  );

  sk.on('user:updated', (user: User) => {
    if (user.socketId === currentUser.value.socketId) {
      currentUser.value = user;
    }
    users.value = users.value.map((u) => (u.socketId === user.socketId ? user : u));
  });

  sk.on('chat:message', (msg: ChatMessage) => {
    messages.value = [...messages.value, msg];
  });

  // Object updates
  sk.on('object:whiteboard_updated', (data: { objectId: string; strokes: WhiteboardStroke[] }) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        objects: currentMap.value.objects.map((o) => {
          if (o.id === data.objectId) {
            return {
              ...o,
              data: { ...o.data, whiteboardStrokes: data.strokes },
            };
          }
          return o;
        }),
      };
      if (activeObjectModal.value && activeObjectModal.value.id === data.objectId) {
        activeObjectModal.value = {
          ...activeObjectModal.value,
          data: { ...activeObjectModal.value.data, whiteboardStrokes: data.strokes },
        };
      }
    }
  });

  sk.on('object:notes_updated', (data: { objectId: string; notes: StickyNote[] }) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        objects: currentMap.value.objects.map((o) => {
          if (o.id === data.objectId) {
            return {
              ...o,
              data: { ...o.data, notes: data.notes },
            };
          }
          return o;
        }),
      };
      if (activeObjectModal.value && activeObjectModal.value.id === data.objectId) {
        activeObjectModal.value = {
          ...activeObjectModal.value,
          data: { ...activeObjectModal.value.data, notes: data.notes },
        };
      }
    }
  });

  sk.on('object:game_updated', (data: { objectId: string; gameState: any }) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        objects: currentMap.value.objects.map((o) => {
          if (o.id === data.objectId) {
            return {
              ...o,
              data: { ...o.data, gameState: data.gameState },
            };
          }
          return o;
        }),
      };
      if (activeObjectModal.value && activeObjectModal.value.id === data.objectId) {
        activeObjectModal.value = {
          ...activeObjectModal.value,
          data: { ...activeObjectModal.value.data, gameState: data.gameState },
        };
      }
    }
  });

  // Map updates
  sk.on('map:object_placed', (newObj: MapObject) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        objects: [...currentMap.value.objects, newObj],
      };
    }
  });

  sk.on('map:object_removed', (objectId: string) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        objects: currentMap.value.objects.filter((o) => o.id !== objectId),
      };
    }
  });

  sk.on('map:object_updated', (data: { objectId: string; object: MapObject }) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        objects: currentMap.value.objects.map((o) => (o.id === data.objectId ? data.object : o)),
      };
      if (activeObjectModal.value && activeObjectModal.value.id === data.objectId) {
        activeObjectModal.value = data.object;
      }
    }
  });

  sk.on('map:tile_changed', (data: { x: number; y: number; tileType: TileType }) => {
    if (currentMap.value) {
      const newTiles = currentMap.value.tiles.map((row) => [...row]);
      newTiles[data.y][data.x] = data.tileType;
      currentMap.value = {
        ...currentMap.value,
        tiles: newTiles,
      };
    }
  });

  sk.on('map:switched', (data: { currentMap: GridMap; users: User[] }) => {
    currentMap.value = data.currentMap;
    users.value = data.users;
    const me = data.users.find((u) => u.socketId === socket.value?.id);
    if (me) currentUser.value = me;
  });

  sk.on('map:zones_updated', (data: { privateZones: PrivateZone[]; users: User[] }) => {
    if (currentMap.value) {
      currentMap.value = {
        ...currentMap.value,
        privateZones: data.privateZones,
      };
    }
    users.value = data.users;
    const me = data.users.find((u) => u.socketId === socket.value?.id);
    if (me) currentUser.value = me;
  });

  // Check for auth_user param in URL (e.g. from redirect)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const authUserParam = urlParams.get('auth_user');
    if (authUserParam) {
      const parsed = JSON.parse(authUserParam);
      if (parsed && parsed.name) {
        authenticatedUser.value = parsed;
        userNameInput.value = parsed.name;
        // Clean URL parameter
        const newUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, newUrl);
      }
    }
  } catch (e) {}

  const handleOAuthMessage = (event: MessageEvent) => {
    const origin = event.origin;
    const isSameOrigin = origin === window.location.origin;
    const isAllowedDomain =
      origin.endsWith('.run.app') ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.includes('personalclientcare.com');

    if (!isSameOrigin && !isAllowedDomain) {
      return;
    }

    if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.user) {
      const u = event.data.user;
      authenticatedUser.value = u;
      if (u.name) {
        userNameInput.value = u.name;
      }

      // Automatically join workspace if not joined yet
      if (!hasJoined.value) {
        handleJoinSpace();
      } else if (socket.value) {
        currentUser.value.name = u.name || 'Member';
        currentUser.value.isAdmin = Boolean(u.isAdmin);
        socket.value.emit('user:update_profile', {
          name: u.name || 'Member',
          isAdmin: Boolean(u.isAdmin),
        });
      }
    }
  };

  window.addEventListener('message', handleOAuthMessage);
  window.addEventListener('keydown', handleGlobalHotkeys);

  onUnmounted(() => {
    window.removeEventListener('message', handleOAuthMessage);
    window.removeEventListener('keydown', handleGlobalHotkeys);
  });
});

onUnmounted(() => {
  if (socket.value) {
    socket.value.disconnect();
  }
});

async function handleJoinSpace() {
  if (!socket.value) return;
  const nameToUse = authenticatedUser.value?.name || userNameInput.value || 'Member';
  const isAdmin = Boolean(authenticatedUser.value?.isAdmin);
  hasJoined.value = true;
  currentUser.value.name = nameToUse;
  currentUser.value.avatar = avatarConfig.value;
  currentUser.value.isAdmin = isAdmin;
  socket.value.emit('user:join', {
    name: nameToUse,
    avatar: avatarConfig.value,
    isAdmin,
    clientId,
    email: authenticatedUser.value?.email,
    // The server verifies this and derives isAdmin/email from it directly - it does not
    // trust the isAdmin/email fields above on their own (see server.ts user:join handler).
    sessionToken: authenticatedUser.value?.sessionToken,
  });

  // Initialize WebRTC audio stream & voice activity detection
  await initLocalAudio();
}

let pathWalkInterval: number | null = null;

function stopPathWalking() {
  if (pathWalkInterval !== null) {
    clearInterval(pathWalkInterval);
    pathWalkInterval = null;
  }
}

function handleMove(data: { x: number; y: number; direction: 'up' | 'down' | 'left' | 'right' }) {
  stopPathWalking();
  if (socket.value && hasJoined.value) {
    socket.value.emit('user:move', data);
  }
}

function handleNavigateTile(target: { x: number; y: number }) {
  stopPathWalking();
  if (!currentMap.value || !currentUser.value?.position || !socket.value || !hasJoined.value) return;

  const start = { x: currentUser.value.position.x, y: currentUser.value.position.y };
  const path = findPathAStar(currentMap.value, start, target);

  if (path.length === 0) return;

  let stepIdx = 0;
  pathWalkInterval = window.setInterval(() => {
    if (stepIdx >= path.length) {
      stopPathWalking();
      return;
    }
    const nextTile = path[stepIdx];
    const curPos = currentUser.value.position;
    const dx = nextTile.x - curPos.x;
    const dy = nextTile.y - curPos.y;

    let dir: 'up' | 'down' | 'left' | 'right' = 'down';
    if (dx > 0) dir = 'right';
    else if (dx < 0) dir = 'left';
    else if (dy > 0) dir = 'down';
    else if (dy < 0) dir = 'up';

    socket.value?.emit('user:move', { x: nextTile.x, y: nextTile.y, direction: dir });
    stepIdx++;
  }, 130);
}

function handleSendMessage(payload: { text: string; isSpatial: boolean }) {
  if (socket.value) {
    socket.value.emit('chat:send', payload);
  }
}

function handleTeleportToUser(data: { x: number; y: number }) {
  handleNavigateTile(data);
}

function handleMoveToDesk() {
  const desk = currentMap.value?.objects.find(
    (obj) => obj.type === 'desk' && obj.data?.deskState?.claimedByUserId === currentUser.value.id
  );
  if (!desk) return;

  const deskWidth = desk.width || 2;
  const deskHeight = desk.height || 1;
  handleNavigateTile({
    x: desk.x + Math.floor(deskWidth / 2),
    y: desk.y + deskHeight,
  });
}

// Global keyboard shortcuts for every action button (movement's WASD/arrow keys are
// handled separately in SpatialCanvas.vue, so none of these overlap with w/a/s/d).
function handleGlobalHotkeys(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
    return;
  }
  if (!hasJoined.value || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Escape') {
    if (activeObjectModal.value) {
      activeObjectModal.value = null;
    } else if (showAvatarBuilderModal.value) {
      showAvatarBuilderModal.value = false;
    } else if (isChatOpen.value) {
      isChatOpen.value = false;
    } else if (builderMode.value) {
      handleToggleBuilderMode();
    } else {
      return;
    }
    e.preventDefault();
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'm':
      handleToggleMute();
      break;
    case 'n':
      handleToggleDeafen();
      break;
    case 'v':
      if (e.shiftKey) {
        switchCamera();
      } else {
        toggleCamera();
      }
      break;
    case 'b':
      if (e.shiftKey) {
        handleToggleBuilderMode();
      } else {
        toggleScreenShare();
      }
      break;
    case 'c':
      handleToggleChat();
      break;
    case 'p':
      showAvatarBuilderModal.value = true;
      break;
    case 'g':
      handleMoveToDesk();
      break;
    default:
      return;
  }
  e.preventDefault();
}

function handleToggleMute() {
  isMuted.value = !isMuted.value;
  if (socket.value) {
    socket.value.emit('user:update_profile', { isMuted: isMuted.value });
  }
}

function handleToggleDeafen() {
  isDeafened.value = !isDeafened.value;
  if (socket.value) {
    socket.value.emit('user:update_profile', { isDeafened: isDeafened.value });
  }
}


function handleUpdateAvatar(newAvatar: AvatarCustomization) {
  avatarConfig.value = newAvatar;
  currentUser.value = {
    ...currentUser.value,
    avatar: newAvatar,
  };
  if (socket.value && hasJoined.value) {
    socket.value.emit('user:update_profile', { avatar: newAvatar });
  }
}

function handleSendWhiteboardStroke(payload: { objectId: string; stroke: WhiteboardStroke }) {
  if (socket.value) {
    socket.value.emit('object:whiteboard_stroke', payload);
  }
}

function handleClearWhiteboard(payload: { objectId: string }) {
  if (socket.value) {
    socket.value.emit('object:whiteboard_clear', payload);
  }
}

function handleAddNote(payload: { objectId: string; note: StickyNote }) {
  if (socket.value) {
    socket.value.emit('object:add_note', payload);
  }
}

function handleMakeGameMove(payload: { objectId: string; index: number; symbol: 'X' | 'O' }) {
  if (socket.value) {
    socket.value.emit('object:game_move', payload);
  }
}

function handleResetGame(payload: { objectId: string }) {
  if (socket.value) {
    socket.value.emit('object:game_reset', payload);
  }
}

const activeZoneBanner = ref<string | null>(null);
let zoneBannerTimeout: number | null = null;

watch(
  () => currentUser.value.currentZoneId,
  (newZoneId, oldZoneId) => {
    if (newZoneId !== oldZoneId) {
      if (zoneBannerTimeout) clearTimeout(zoneBannerTimeout);
      if (newZoneId && currentMap.value) {
        const zone = currentMap.value.privateZones.find((z) => z.id === newZoneId);
        const name = zone ? zone.name : 'Private Zone';
        activeZoneBanner.value = `🔒 Entered Private Zone: ${name} (Audio is isolated to members in this room)`;
      } else if (oldZoneId) {
        activeZoneBanner.value = `🌐 Left Private Zone — Returned to spatial proximity audio`;
      }

      zoneBannerTimeout = window.setTimeout(() => {
        activeZoneBanner.value = null;
      }, 4000);
    }
  }
);

function handleAddZone(zone: PrivateZone) {
  if (socket.value) {
    socket.value.emit('map:add_zone', zone);
  }
}

function handleRemoveZone(zoneId: string) {
  if (socket.value) {
    socket.value.emit('map:remove_zone', zoneId);
  }
}

function handleUpdateDesk(payload: { objectId: string; deskState: any }) {
  if (socket.value) {
    socket.value.emit('object:desk_updated', payload);
  }
}

function handlePlaceObject(newObj: MapObject) {
  if (socket.value) {
    socket.value.emit('map:place_object', newObj);
  }
}

function handleRemoveObject(objectId: string) {
  if (socket.value) {
    socket.value.emit('map:remove_object', objectId);
  }
}

function handleChangeTile(payload: { x: number; y: number; tileType: TileType }) {
  if (socket.value) {
    socket.value.emit('map:change_tile', payload);
  }
}

function handleSwitchMapPreset(mapId: string) {
  if (!currentUser.value?.isAdmin) return;
  if (socket.value) {
    socket.value.emit('map:switch_preset', mapId);
  }
}

function handleToggleBuilderMode() {
  if (currentUser.value?.isAdmin) {
    builderMode.value = !builderMode.value;
  } else {
    builderMode.value = false;
  }
}
</script>

<template>
  <div class="w-screen h-screen bg-slate-950 text-slate-100 flex flex-col relative overflow-hidden font-sans">
    <!-- Join Landing Screen -->
    <div
      v-if="!hasJoined"
      class="fixed inset-0 bg-amber-500 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto custom-scrollbar"
      style="background-image: radial-gradient(#d97706 2px, transparent 2px); background-size: 24px 24px;"
    >
      <div class="bg-white text-slate-900 border-3 border-slate-900 rounded-3xl p-5 sm:p-8 shadow-[12px_12px_0px_0px_#0f172a] max-w-lg w-full flex flex-col items-center text-center my-auto">
        <div class="w-16 h-16 bg-amber-300 text-slate-950 rounded-2xl border-3 border-slate-900 flex items-center justify-center mb-3 shadow-[4px_4px_0px_0px_#0f172a]">
          <Compass class="w-8 h-8" />
        </div>

        <h1 class="text-2xl sm:text-3xl font-black text-slate-950 font-press-start tracking-tight drop-shadow-sm">peer-space</h1>
        <p class="text-xs text-slate-700 font-extrabold mt-2 mb-6 font-heading">
          2D Spatial Virtual Office & Pixel Collaboration Hub
        </p>

        <!-- Avatar Selector Customizer -->
        <div class="mb-5 w-full flex justify-center">
          <AvatarBuilder
            :avatar="avatarConfig"
            @update:avatar="handleUpdateAvatar"
            :showClose="false"
          />
        </div>

        <!-- Social Keycloak / Google Auth Login & Space Join Section -->
        <div class="mb-2 w-full flex flex-col gap-3">
          <div v-if="authenticatedUser" class="flex flex-col gap-3">
            <div class="p-3 bg-amber-100 border-2 border-slate-900 rounded-xl flex items-center justify-between text-xs font-bold text-slate-900 shadow-[2px_2px_0px_0px_#0f172a]">
              <div class="flex items-center gap-2 text-left">
                <ShieldCheck class="w-5 h-5 text-emerald-600 shrink-0" />
                <div>
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <p class="font-extrabold text-slate-900">Signed in as {{ authenticatedUser.name }}</p>
                    <span v-if="authenticatedUser.isAdmin" class="bg-amber-400 text-slate-950 px-1.5 py-0.5 rounded text-[9px] font-black border border-slate-900 font-heading uppercase">Admin</span>
                  </div>
                  <p v-if="authenticatedUser.email" class="text-[10px] text-slate-600 font-semibold truncate max-w-50">{{ authenticatedUser.email }}</p>
                </div>
              </div>
              <button type="button" @click="handleLogout" class="p-1 hover:bg-amber-200 rounded-lg border border-slate-900 text-slate-900 font-bold flex items-center gap-1 pixel-btn" title="Sign Out">
                <LogOut class="w-3.5 h-3.5" />
              </button>
            </div>

            <form @submit.prevent="handleJoinSpace" class="w-full">
              <button
                type="submit"
                class="w-full bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-3.5 rounded-xl text-xs font-black border-2 border-slate-900 flex items-center justify-center gap-2 transition-all whitespace-nowrap cursor-pointer pixel-btn font-press-start shadow-[3px_3px_0px_0px_#0f172a]"
              >
                <Sparkles class="w-4 h-4" /> ENTER SPACE
              </button>
            </form>
          </div>

          <div v-else class="flex flex-col gap-3">
            <div class="bg-amber-100 border-2 border-slate-900 p-3 rounded-xl text-center">
              <p class="text-xs font-extrabold text-slate-900 font-heading">
                Authentication Required
              </p>
              <p class="text-[11px] text-slate-700 font-semibold mt-0.5">
                Please log in with Google or Keycloak to enter the workspace.
              </p>
            </div>

            <div class="flex flex-col sm:flex-row items-center gap-2.5 w-full mt-1">
              <button
                type="button"
                @click="handleKeycloakLogin('google')"
                class="w-full sm:flex-1 bg-white hover:bg-slate-50 text-slate-900 px-3.5 py-3 rounded-xl border-2 border-slate-900 text-xs font-extrabold flex items-center justify-center gap-2 transition-all pixel-btn shadow-[3px_3px_0px_0px_#0f172a] font-heading cursor-pointer"
              >
                <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                </svg>
                <span>Google Login</span>
              </button>

              <button
                type="button"
                @click="handleKeycloakLogin('keycloak')"
                class="w-full sm:flex-1 bg-indigo-100 hover:bg-indigo-200 text-indigo-950 px-3.5 py-3 rounded-xl border-2 border-slate-900 text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all pixel-btn shadow-[3px_3px_0px_0px_#0f172a] font-heading cursor-pointer"
              >
                <LogIn class="w-4 h-4 text-indigo-700" />
                <span>Keycloak SSO</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Spatial Workspace Canvas -->
    <div class="flex-1 relative flex items-center justify-center overflow-hidden">
      <!-- Header Bar & Private Zone Notification Banner -->
      <div class="absolute top-4 left-4 z-30 flex items-center gap-2.5 sm:gap-3 bg-white border-3 border-slate-900 px-3 sm:px-4 py-2 rounded-2xl shadow-[5px_5px_0px_0px_#0f172a]">
        <div class="w-8 h-8 bg-amber-300 text-slate-950 border-2 border-slate-900 rounded-lg flex items-center justify-center font-black text-xs font-press-start shadow-[2px_2px_0px_0px_#0f172a] shrink-0">
          P
        </div>
        <div>
          <h2 class="text-xs font-black text-slate-900 font-press-start tracking-tight leading-none">peer-space</h2>
          <div class="flex items-center gap-1.5 mt-1">
            <p class="text-[10px] text-amber-700 font-extrabold font-heading">Pixel Office World</p>
            <span v-if="currentUser.isAdmin" class="bg-amber-400 text-slate-950 px-1 py-0.2 rounded text-[8px] font-black border border-slate-900 font-heading uppercase">Admin</span>
          </div>
        </div>

        <!-- Map Builder Quick Access (Visible for Admin Users) -->
        <button
          v-if="currentUser.isAdmin"
          type="button"
          @click="handleToggleBuilderMode"
          :title="builderMode ? 'Close Map Builder (Shift+B)' : 'Open Map Builder (Admin) (Shift+B)'"
          :class="`text-[10px] font-bold px-2.5 py-1 rounded-lg border-2 border-slate-900 flex items-center gap-1.5 transition-all pixel-btn shadow-[2px_2px_0px_0px_#0f172a] font-heading ${
            builderMode
              ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
              : 'bg-indigo-100 text-indigo-950 hover:bg-indigo-200'
          }`"
        >
          <Hammer class="w-3.5 h-3.5" />
          <span>{{ builderMode ? 'Exit Builder' : 'Map Builder' }}</span>
        </button>
      </div>

      <!-- Private Zone Entrance / Exit Toast Banner -->
      <transition
        enter-active-class="transition duration-300 ease-out"
        enter-from-class="opacity-0 -translate-y-4"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-200 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-4"
      >
        <div
          v-if="activeZoneBanner"
          class="absolute top-4 z-40 bg-amber-300 text-slate-950 border-3 border-slate-900 px-4 py-2.5 rounded-2xl shadow-[6px_6px_0px_0px_#0f172a] font-heading font-extrabold text-xs flex items-center gap-2 max-w-md text-center"
        >
          <span>{{ activeZoneBanner }}</span>
        </div>
      </transition>

      <!-- Spatial Canvas -->
      <SpatialCanvas
        :currentUser="currentUser"
        :users="users"
        :currentMap="currentMap"
        :builderMode="builderMode"
        :builderAction="builderAction"
        :selectedTile="selectedTile"
        :selectedObject="selectedObject"
        @move="handleMove"
        @navigateTile="handleNavigateTile"
        @interactObject="(obj) => activeObjectModal = obj"
        @placeObject="handlePlaceObject"
        @removeObject="handleRemoveObject"
        @changeTile="handleChangeTile"
      />

      <!-- Map Builder Drawer -->
      <MapBuilderDrawer
        :isOpen="builderMode"
        :builderAction="builderAction"
        :selectedTile="selectedTile"
        :selectedObject="selectedObject"
        :currentMapId="currentMap.id"
        :privateZones="currentMap.privateZones"
        @close="builderMode = false"
        @setBuilderAction="(act) => builderAction = act"
        @setSelectedTile="(tile) => selectedTile = tile"
        @setSelectedObject="(obj) => selectedObject = obj"
        @switchMapPreset="handleSwitchMapPreset"
        @addZone="handleAddZone"
        @removeZone="handleRemoveZone"
      />

      <!-- Proximity Chat & People Panel -->
      <ProximityChatPanel
        :currentUser="currentUser"
        :users="users"
        :messages="messages"
        :isOpen="isChatOpen"
        @sendMessage="handleSendMessage"
        @teleportToUser="handleTeleportToUser"
        @close="isChatOpen = false"
      />

      <!-- Interactive Spatial Minimap -->
      <MiniMap
        :currentMap="currentMap"
        :users="users"
        :currentUser="currentUser"
        @navigateTile="handleNavigateTile"
      />

      <!-- Floating Bottom Control Bar -->
      <ControlBar
        :isMuted="isMuted"
        :isDeafened="isDeafened"
        :isVideoOn="isVideoOn"
        :isScreenSharing="isScreenSharing"
        :builderMode="builderMode"
        :currentUser="currentUser"
        :currentMap="currentMap"
        :isChatOpen="isChatOpen"
        :unreadChatCount="unreadChatCount"
        @toggleMute="handleToggleMute"
        @toggleDeafen="handleToggleDeafen"
        @toggleCamera="toggleCamera"
        @toggleScreenShare="toggleScreenShare"
        @toggleBuilderMode="handleToggleBuilderMode"
        @openAvatarBuilder="showAvatarBuilderModal = true"
        @toggleChat="handleToggleChat"
        @moveToDesk="handleMoveToDesk"
      />

      <!-- Floating WebRTC Video Dock -->
      <VideoDock
        :currentUser="currentUser"
        :users="users"
        :isVideoOn="isVideoOn"
        :localVideoStream="localVideoStream"
        :remoteVideoStreams="remoteVideoStreams"
        :isScreenSharing="isScreenSharing"
        :localScreenStream="localScreenStream"
        :remoteScreenStreams="remoteScreenStreams"
        :canSwitchCamera="availableVideoDevices.length > 1"
        @toggleCamera="toggleCamera"
        @switchCamera="switchCamera()"
      />
    </div>

    <!-- Avatar Builder Overlay Modal -->
    <div
      v-if="showAvatarBuilderModal"
      class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
    >
      <AvatarBuilder
        :avatar="avatarConfig"
        @update:avatar="handleUpdateAvatar"
        :showClose="true"
        @close="showAvatarBuilderModal = false"
      />
    </div>

    <!-- Interactive Object Modal -->
    <ObjectModals
      :object="activeObjectModal"
      :currentUser="currentUser"
      @close="activeObjectModal = null"
      @sendWhiteboardStroke="handleSendWhiteboardStroke"
      @clearWhiteboard="handleClearWhiteboard"
      @addNote="handleAddNote"
      @makeGameMove="handleMakeGameMove"
      @resetGame="handleResetGame"
      @updateDesk="handleUpdateDesk"
    />
  </div>
</template>
