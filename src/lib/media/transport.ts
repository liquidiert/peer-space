/**
 * The network layer for proximity media: an iroh endpoint running in the browser through
 * WebAssembly (crates/peer-media). It is behind an interface so tests can swap in an
 * in-memory transport.
 */

/** Incoming traffic on one peer link. */
export type LinkEvent =
  | { type: 'datagram'; data: Uint8Array }
  | { type: 'message'; data: Uint8Array }
  | { type: 'closed'; reason?: string };

/** Sending half of one ordered stream (a video track or the control channel). */
export interface TrackOut {
  /** Queue a message. False when the queue is full or the stream is gone: the message is dropped. */
  send(data: Uint8Array): boolean;
  close(): void;
}

/** One authenticated connection to one peer. */
export interface PeerLink {
  readonly remoteId: string;
  start(onEvent: (ev: LinkEvent) => void): void;
  /** Unreliable and unordered; false when it couldn't be queued. */
  sendDatagram(data: Uint8Array): boolean;
  /** Ordered, reliable stream; higher priority wins under congestion; `queue` bounds latency. */
  openStream(priority: number, queue: number): Promise<TrackOut>;
  close(): void;
}

export interface MediaTransport {
  readonly id: string;
  readonly relay?: string;
  sign(data: Uint8Array): Uint8Array;
  verify(endpointId: string, data: Uint8Array, sig: Uint8Array): boolean;
  /** Teach the endpoint where a peer can be reached before dialing it. */
  addPeer(endpointId: string, relay?: string): void;
  connect(endpointId: string): Promise<PeerLink>;
  /** Next incoming link, or undefined once the transport is closed. */
  accept(): Promise<PeerLink | undefined>;
  close(): void;
}

export type TransportFactory = () => Promise<MediaTransport>;

/**
 * Relay servers to use instead of n0's public ones, from `VITE_IROH_RELAYS`
 * (comma-separated `https://` URLs). Browsers reach peers only through a relay, so any
 * deployment that carries real traffic should run its own (`iroh-relay`).
 */
export function configuredRelays(): string[] {
  const env = (import.meta as any).env ?? {};
  return String(env.VITE_IROH_RELAYS ?? '')
    .split(',')
    .map((u: string) => u.trim())
    .filter((u: string) => /^https?:\/\//.test(u));
}

/** The real transport: loads the wasm module on first use. */
export const createIrohTransport: TransportFactory = async () => {
  const wasm = await import('../../wasm/peer_media.js');
  await wasm.default();
  const node = await wasm.MediaNode.spawn(configuredRelays());
  const relay =
    (await Promise.race([node.online(), new Promise<undefined>((r) => setTimeout(r, 15_000))])) ??
    node.relayUrl() ??
    undefined;

  const wrap = (conn: InstanceType<typeof wasm.MediaConn>): PeerLink => ({
    remoteId: conn.remoteId(),
    start: (onEvent) => conn.start(onEvent as (ev: unknown) => void),
    sendDatagram: (data) => conn.sendDatagram(data),
    openStream: async (priority, queue) => {
      const out = await conn.openStream(priority, queue);
      return { send: (data) => out.send(data), close: () => out.close() };
    },
    close: () => conn.close(),
  });

  return {
    id: node.endpointId(),
    relay,
    sign: (data) => node.sign(data),
    verify: (id, data, sig) => wasm.verify(id, data, sig),
    addPeer: (id, relayUrl) => node.addPeer(id, relayUrl),
    connect: async (id) => wrap(await node.connect(id)),
    accept: async () => {
      const conn = await node.accept();
      return conn ? wrap(conn) : undefined;
    },
    close: () => void node.close(),
  };
};
