/**
 * The network layer for proximity media: an iroh endpoint running in the browser through
 * WebAssembly (crates/peer-media). It is behind an interface so tests can swap in an
 * in-memory transport.
 */

import type { MediaConn } from '../../wasm/peer_media.js';

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

/** Called as soon as the endpoint id exists, before the transport is ready. */
export interface TransportHooks {
  onEndpointId?: (id: string) => void;
}

export type TransportFactory = (hooks?: TransportHooks) => Promise<MediaTransport>;

/**
 * Keeps only the `http(s)://` entries of a relay list, trimmed. Anything else (empty
 * strings, bare hosts, other schemes, non-strings) is dropped.
 */
export function keepHttpUrls(items: readonly unknown[]): string[] {
  return items
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
}

/** Parses a comma-separated relay list such as the `IROH_RELAYS` or `VITE_IROH_RELAYS` value. */
export function parseRelayList(raw: string | undefined): string[] {
  return keepHttpUrls(String(raw ?? '').split(','));
}

/**
 * Relay servers to use instead of n0's public ones, from the build-time `VITE_IROH_RELAYS`
 * (comma-separated `https://` URLs). This is the fallback behind the runtime list the server
 * serves at `/api/media-config`; see `resolveRelays`. Browsers reach peers only through a
 * relay, so any deployment that carries real traffic should run its own (`iroh-relay`).
 */
export function configuredRelays(): string[] {
  return parseRelayList(import.meta.env.VITE_IROH_RELAYS);
}

const MEDIA_CONFIG_TIMEOUT_MS = 3_000;

/**
 * The relay list to dial, in order of precedence:
 *   1. runtime `IROH_RELAYS` on the server, served at `GET /api/media-config`, so deployers
 *      can change it without rebuilding the prebuilt image;
 *   2. build-time `VITE_IROH_RELAYS` (`configuredRelays`);
 *   3. nothing, which makes iroh use n0's public relays.
 * Never throws: a timeout, network error, non-ok response, or empty or invalid list falls
 * through to the next step.
 */
export async function resolveRelays(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_CONFIG_TIMEOUT_MS);
    try {
      const res = await fetchImpl('/api/media-config', { signal: controller.signal });
      if (res.ok) {
        const body = (await res.json()) as { relays?: unknown } | null;
        const relays = Array.isArray(body?.relays) ? keepHttpUrls(body.relays) : [];
        if (relays.length > 0) return relays;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Unreachable server, timeout, or malformed JSON: use the build-time list below.
  }
  return configuredRelays();
}

/** The real transport: loads the wasm module on first use. */
export const createIrohTransport: TransportFactory = async (hooks) => {
  const wasm = await import('../../wasm/peer_media.js');
  await wasm.default();
  const node = await wasm.MediaNode.spawn(await resolveRelays());
  // The self-hosted relay admits only endpoint ids the app server already knows, and the node
  // starts dialing the relay as soon as it is spawned. So hand the id to the caller now (it
  // registers it with the server) rather than after online(), which would wait on a relay
  // that is refusing us until that registration arrives. A failing hook must not break this.
  try {
    hooks?.onEndpointId?.(node.endpointId());
  } catch (err) {
    console.warn('onEndpointId hook failed:', err);
  }
  const relay =
    (await Promise.race([node.online(), new Promise<undefined>((r) => setTimeout(r, 15_000))])) ??
    node.relayUrl() ??
    undefined;

  const wrap = (conn: MediaConn): PeerLink => ({
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
