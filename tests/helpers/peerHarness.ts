import { createApp, nextTick, ref, type Ref } from 'vue';
import { useProximityMedia } from '../../src/composables/useProximityMedia';
import { validAnnounce } from '../../src/lib/media/wire';
import type { User } from '../../src/types';
import { FakeNetwork, type FakeTransport } from './fakeIroh';
import { fakeMediaDeps } from './fakeMedia';

/**
 * Runs real `useProximityMedia` instances against a fake signalling room (doing what
 * server.ts does with `media:announce` and profile updates) and an in-memory iroh network,
 * so tests exercise the actual connect/route/teardown logic between several clients.
 */

type Composable = ReturnType<typeof useProximityMedia>;

export function makeUser(overrides: Partial<User> & { socketId: string }): User {
  return {
    id: overrides.socketId,
    socketId: overrides.socketId,
    name: overrides.socketId,
    position: { x: 0, y: 0 },
    direction: 'down',
    avatar: {
      skinColor: '#f87171',
      hairStyle: 'short',
      hairColor: '#1e293b',
      outfitColor: '#3b82f6',
      glasses: false,
      hatStyle: 'none',
      statusEmoji: '👋',
    },
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    isScreenSharing: false,
    currentZoneId: null,
    lastSeen: Date.now(),
    presenceStatus: 'available',
    ...overrides,
  } as User;
}

export interface PeerClient {
  socketId: string;
  api: Composable;
  currentUser: Ref<User>;
  users: Ref<User[]>;
  isMuted: Ref<boolean>;
  isDeafened: Ref<boolean>;
  created: ReturnType<typeof fakeMediaDeps>['created'];
  transport: () => FakeTransport | undefined;
  emitted: Array<{ event: string; payload: any }>;
  destroy(): void;
}

export class Room {
  readonly net = new FakeNetwork();
  readonly clients = new Map<string, PeerClient>();
  private users: User[] = [];

  /** Join like a browser would: get init:state, everyone else gets user:joined. */
  join(user: User, endpointPrefix: string): PeerClient {
    this.users = [...this.users.filter((u) => u.socketId !== user.socketId), user];
    const client = this.createClient(user, endpointPrefix);
    this.clients.set(user.socketId, client);
    this.broadcastUsers();
    return client;
  }

  /** The server's user:left: drop them everywhere. */
  leave(socketId: string) {
    this.clients.get(socketId)?.destroy();
    this.clients.delete(socketId);
    this.users = this.users.filter((u) => u.socketId !== socketId);
    this.broadcastUsers();
  }

  /** A server-side change to one user (move, profile update, announce) reaching everyone. */
  update(socketId: string, patch: Partial<User>) {
    this.users = this.users.map((u) => (u.socketId === socketId ? { ...u, ...patch } : u));
    this.broadcastUsers();
  }

  move(socketId: string, x: number, y: number, zone: string | null = null) {
    this.update(socketId, { position: { x, y }, currentZoneId: zone });
  }

  /** Inject a user record directly (e.g. a forged announce the real server would accept). */
  setUsers(users: User[]) {
    this.users = users;
    this.broadcastUsers();
  }

  get userList() {
    return this.users;
  }

  /** Clients whose view of the room is frozen, to model a slow socket. */
  private frozen = new Set<string>();

  freeze(socketId: string) {
    this.frozen.add(socketId);
  }

  unfreeze(socketId: string) {
    this.frozen.delete(socketId);
    this.broadcastUsers();
  }

  private broadcastUsers() {
    for (const c of this.clients.values()) {
      if (this.frozen.has(c.socketId)) continue;
      c.users.value = this.users.map((u) => ({ ...u }));
      const me = this.users.find((u) => u.socketId === c.socketId);
      if (me) c.currentUser.value = { ...me };
      c.api.syncPeerConnections();
    }
  }

  private createClient(user: User, prefix: string): PeerClient {
    const emitted: Array<{ event: string; payload: any }> = [];
    const { deps, created } = fakeMediaDeps(this.net.factory(prefix));
    let transport: FakeTransport | undefined;
    const createTransport = deps.createTransport;
    deps.createTransport = async () => (transport = (await createTransport()) as FakeTransport);

    const socket = ref<any>({
      id: user.socketId,
      emit: (event: string, payload: any) => {
        emitted.push({ event, payload });
        if (event === 'media:announce' && validAnnounce(payload)) {
          // Defer like a network round trip.
          queueMicrotask(() => this.update(user.socketId, { media: payload }));
        } else if (event === 'user:update_profile') {
          const { isSpeaking: _ignored, ...rest } = payload;
          if (Object.keys(rest).length) queueMicrotask(() => this.update(user.socketId, rest));
        }
      },
    });

    const currentUser = ref<User>({ ...user });
    const users = ref<User[]>(this.users.map((u) => ({ ...u })));
    const isMuted = ref(false);
    const isDeafened = ref(false);

    let api!: Composable;
    const app = createApp({
      setup() {
        api = useProximityMedia(socket as any, currentUser as any, users as any, isMuted as any, isDeafened as any, deps);
        return () => null;
      },
    });
    app.mount(document.createElement('div'));

    return {
      socketId: user.socketId,
      api,
      currentUser,
      users,
      isMuted,
      isDeafened,
      created,
      transport: () => transport,
      emitted,
      destroy: () => app.unmount(),
    };
  }
}

/** Let async connects, announces and watchers run to completion. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}
