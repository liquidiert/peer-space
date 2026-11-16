/**
 * Access control for the self-hosted iroh relay. The relay calls back into the app server
 * (HTTP access mode) before it admits a connecting endpoint, and the server admits only
 * endpoint ids that belong to a socket currently joined to the app (a signed-in user).
 *
 * Pure logic only: server.ts starts the whole app when imported, so the handlers call into
 * this module and tests exercise it directly.
 */
import { timingSafeEqual } from 'crypto';

/**
 * A relay endpoint id: 32-byte public key as 64 lowercase hex chars. Matches `ENDPOINT_ID_RE`
 * in wire.ts, which is what announces are validated against.
 *
 * Input is lowercased at the boundary (the socket handler and the relay route) and not here:
 * iroh always emits lowercase, and a case-insensitive check would let two spellings of one
 * key sit side by side in the registry. Uppercase input is accepted at the boundary and
 * stored lowercased, so it can't be used to slip past or duplicate a registration.
 */
export function isEndpointIdHex(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

/**
 * Which endpoint each joined socket is allowed to use on the relay. One id per socket and
 * one socket per id: an id held by one socket can't be taken by another.
 */
export class RelayAccessRegistry {
  /** socket id -> endpoint id it registered. */
  private bySocket = new Map<string, string>();
  /** endpoint id -> socket id that holds it. */
  private byEndpoint = new Map<string, string>();

  /**
   * Admit `endpointId` for `socketId`, replacing any id the socket held before. Returns false
   * (and changes nothing) if the id is invalid or another socket holds it. Callers lowercase
   * the id first.
   */
  register(socketId: string, endpointId: string): boolean {
    if (!isEndpointIdHex(endpointId)) return false;
    const holder = this.byEndpoint.get(endpointId);
    if (holder !== undefined && holder !== socketId) return false;

    const previous = this.bySocket.get(socketId);
    if (previous !== undefined && previous !== endpointId) this.byEndpoint.delete(previous);
    this.bySocket.set(socketId, endpointId);
    this.byEndpoint.set(endpointId, socketId);
    return true;
  }

  /** Drop whatever id the socket registered, if any. */
  unregister(socketId: string): void {
    const endpointId = this.bySocket.get(socketId);
    if (endpointId === undefined) return;
    this.bySocket.delete(socketId);
    if (this.byEndpoint.get(endpointId) === socketId) this.byEndpoint.delete(endpointId);
  }

  /** Whether the relay should admit this endpoint id. */
  allows(endpointId: string): boolean {
    return this.byEndpoint.has(endpointId);
  }
}

/**
 * Checks an `Authorization` header against the configured token. Expects exactly
 * `Bearer <token>` (the scheme spelled as the relay sends it). Compared in constant time;
 * unequal lengths are rejected before comparing, since timingSafeEqual requires equal sizes.
 * An empty configured token never matches.
 */
export function checkBearer(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
