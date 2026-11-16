/**
 * An in-memory stand-in for the iroh transport: endpoints on one FakeNetwork can dial each
 * other by id, links deliver datagrams and stream messages to the other side, and either
 * side can be cut off to model a dropped connection.
 */
import type { LinkEvent, MediaTransport, PeerLink, TrackOut, TransportHooks } from '../../src/lib/media/transport';
import { fromHex, toHex } from '../../src/lib/media/wire';

let counter = 0;
const newEndpointId = (prefix: string) => (prefix + (counter++).toString(16)).padEnd(64, '0').slice(0, 64);

/** Toy signature: binds the signer's id to a checksum of the data. Not crypto, just shaped like it. */
function fakeSign(id: string, data: Uint8Array): Uint8Array {
  let h = 2166136261;
  for (const b of [...new TextEncoder().encode(id), ...data]) h = Math.imul(h ^ b, 16777619) >>> 0;
  const out = new Uint8Array(64);
  out.set(fromHex(id).subarray(0, 32), 0);
  new DataView(out.buffer).setUint32(32, h);
  return out;
}

export class FakeLink implements PeerLink {
  other!: FakeLink;
  private handler: ((ev: LinkEvent) => void) | null = null;
  private backlog: LinkEvent[] = [];
  closed = false;
  datagramsSent: Uint8Array[] = [];
  /** Make every stream refuse sends, like a congested link. */
  congested = false;
  /**
   * Queue stream messages in `held` instead of delivering them. Held messages stay queued
   * after their stream is closed (the real transport drains them), and `releaseHeld` delivers
   * them later, so tests can reorder streams relative to each other (a control message can
   * overtake video sent before it).
   */
  holdStreams = false;
  held: Uint8Array[] = [];

  constructor(readonly remoteId: string, readonly localId: string) {}

  start(onEvent: (ev: LinkEvent) => void) {
    if (this.handler) return;
    this.handler = onEvent;
    this.backlog.splice(0).forEach((ev) => onEvent(ev));
  }

  deliver(ev: LinkEvent) {
    if (this.handler) this.handler(ev);
    else this.backlog.push(ev);
  }

  sendDatagram(data: Uint8Array) {
    if (this.closed) return false;
    this.datagramsSent.push(data);
    this.other.deliver({ type: 'datagram', data });
    return true;
  }

  async openStream(): Promise<TrackOut> {
    if (this.closed) throw new Error('connection closed');
    let open = true;
    return {
      send: (data) => {
        if (!open || this.closed || this.congested) return false;
        if (this.holdStreams) {
          this.held.push(data);
          return true;
        }
        this.other.deliver({ type: 'message', data });
        return true;
      },
      close: () => {
        open = false;
      },
    };
  }

  /** Deliver held messages that match `filter`, in the order they were sent; the rest stay held. */
  releaseHeld(filter: (data: Uint8Array) => boolean = () => true) {
    const matching: Uint8Array[] = [];
    this.held = this.held.filter((data) => {
      if (!filter(data)) return true;
      matching.push(data);
      return false;
    });
    for (const data of matching) this.other.deliver({ type: 'message', data });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.other.closed = true;
    this.deliver({ type: 'closed', reason: 'closed locally' });
    this.other.deliver({ type: 'closed', reason: 'closed by peer' });
  }
}

export class FakeTransport implements MediaTransport {
  readonly relay = 'https://relay.test./';
  private incoming: FakeLink[] = [];
  private waiting: ((l: FakeLink | undefined) => void) | null = null;
  links: FakeLink[] = [];
  closed = false;
  dials: string[] = [];

  constructor(private net: FakeNetwork, readonly id: string) {}

  sign(data: Uint8Array) {
    return fakeSign(this.id, data);
  }
  verify(id: string, data: Uint8Array, sig: Uint8Array) {
    return toHex(fakeSign(id, data)) === toHex(sig);
  }
  addPeer() {}

  async connect(id: string): Promise<PeerLink> {
    this.dials.push(id);
    const target = this.net.endpoints.get(id);
    if (!target || target.closed || this.net.unreachable.has(id)) throw new Error(`no route to ${id}`);
    const mine = new FakeLink(id, this.id);
    const theirs = new FakeLink(this.id, id);
    mine.other = theirs;
    theirs.other = mine;
    this.links.push(mine);
    target.links.push(theirs);
    target.push(theirs);
    return mine;
  }

  push(link: FakeLink) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(link);
    } else this.incoming.push(link);
  }

  accept(): Promise<PeerLink | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const next = this.incoming.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  close() {
    this.closed = true;
    this.links.forEach((l) => l.close());
    this.waiting?.(undefined);
  }
}

export class FakeNetwork {
  endpoints = new Map<string, FakeTransport>();
  unreachable = new Set<string>();

  /** Transports get ids in creation order, so `order` decides who dials whom. */
  factory(prefix: string) {
    return async (hooks?: TransportHooks) => {
      const t = new FakeTransport(this, newEndpointId(prefix));
      this.endpoints.set(t.id, t);
      // Like createIrohTransport: the id is known before the transport resolves.
      hooks?.onEndpointId?.(t.id);
      return t;
    };
  }
}
