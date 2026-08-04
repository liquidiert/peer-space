import { createApp, ref, type Ref } from 'vue';
import { useWebRTCProximity } from '../../src/composables/useWebRTCProximity';
import type { User } from '../../src/types';

/**
 * Spins up real `useWebRTCProximity` instances and wires their signalling together the way
 * server.ts does (`webrtc:signal` is relayed verbatim to the target socket), so tests exercise
 * the actual negotiation flow between two clients rather than a mock of it.
 */

type Composable = ReturnType<typeof useWebRTCProximity>;

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

export interface EmittedSignal {
  from: string;
  to: string;
  signal: any;
}

export class SignalBus {
  private clients = new Map<string, PeerClient>();
  /** Every relayed webrtc:signal, in order - useful for asserting negotiation behaviour. */
  readonly log: EmittedSignal[] = [];
  /** When true, signals are queued instead of delivered, to model in-flight races. */
  paused = false;
  private queue: EmittedSignal[] = [];
  private inFlight: Promise<unknown>[] = [];

  register(client: PeerClient) {
    this.clients.set(client.socketId, client);
  }

  unregister(socketId: string) {
    this.clients.delete(socketId);
  }

  send(msg: EmittedSignal) {
    this.log.push(msg);
    if (this.paused) {
      this.queue.push(msg);
      return;
    }
    this.deliver(msg);
  }

  private deliver(msg: EmittedSignal) {
    const target = this.clients.get(msg.to);
    if (!target) return; // peer already gone - mirrors io.to(<stale id>) being a no-op
    const handled = target.api
      .handleSignal({ from: msg.from, signal: msg.signal })
      .then(() => this.linkPeerConnections(msg.from, msg.to, msg.signal?.channel));
    this.inFlight.push(handled);
  }

  /** Once both sides have created their RTCPeerConnection for each other, wire them
   * together so addTrack/removeTrack on one side actually reach the other's ontrack -
   * a real signaling server never needs to know about this, it's purely a test-harness
   * stand-in for the two browsers' independent WebRTC stacks. */
  private linkPeerConnections(idA: string, idB: string, channel?: string) {
    const clientA = this.clients.get(idA);
    const clientB = this.clients.get(idB);
    if (!clientA || !clientB) return;

    const debugKey = channel === 'screen' ? '__debugScreenPeerConnections' : '__debugPeerConnections';
    const pcA = (clientA.api as any)[debugKey]?.get(idB);
    const pcB = (clientB.api as any)[debugKey]?.get(idA);
    if (pcA && pcB) {
      pcA.linkTo(pcB);
      pcB.linkTo(pcA);
    }
  }

  /** Deliver everything queued while paused. */
  releaseQueued() {
    this.paused = false;
    const queued = this.queue.splice(0);
    queued.forEach((m) => this.deliver(m));
  }

  /** Wait until all signal handling (and any cascades) has settled. */
  async settle() {
    for (let i = 0; i < 30; i++) {
      const pending = this.inFlight.splice(0);
      if (pending.length === 0) {
        // Give any queued microtasks/promise chains a chance to enqueue more work.
        await new Promise((r) => setTimeout(r, 0));
        if (this.inFlight.length === 0) return;
        continue;
      }
      await Promise.allSettled(pending);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  signalsOfType(type: string) {
    return this.log.filter((m) => m.signal?.type === type);
  }

  clearLog() {
    this.log.length = 0;
  }
}

export interface PeerClient {
  socketId: string;
  api: Composable;
  currentUser: Ref<User>;
  users: Ref<User[]>;
  isMuted: Ref<boolean>;
  isDeafened: Ref<boolean>;
  /** Everything emitted on the socket, for asserting profile updates etc. */
  emitted: Array<{ event: string; payload: any }>;
  destroy(): void;
}

export function createPeerClient(bus: SignalBus, socketId: string, users: User[]): PeerClient {
  const emitted: Array<{ event: string; payload: any }> = [];

  const socket = ref<any>({
    id: socketId,
    emit(event: string, payload: any) {
      emitted.push({ event, payload });
      if (event === 'webrtc:signal') {
        bus.send({ from: socketId, to: payload.to, signal: payload.signal });
      }
    },
  });

  const currentUser = ref<User>(users.find((u) => u.socketId === socketId)!);
  const usersRef = ref<User[]>(users);
  const isMuted = ref(false);
  const isDeafened = ref(false);

  let api!: Composable;
  const app = createApp({
    setup() {
      api = useWebRTCProximity(socket as any, currentUser as any, usersRef as any, isMuted as any, isDeafened as any);
      return () => null;
    },
  });
  app.mount(document.createElement('div'));

  const client: PeerClient = {
    socketId,
    api,
    currentUser,
    users: usersRef,
    isMuted,
    isDeafened,
    emitted,
    destroy() {
      bus.unregister(socketId);
      app.unmount();
    },
  };

  bus.register(client);
  return client;
}
