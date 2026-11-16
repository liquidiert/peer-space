import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePacket } from '../src/lib/media/wire';
import { installMediaMocks } from './helpers/fakeMedia';
import { makeUser, Room, settle, type PeerClient } from './helpers/peerHarness';

/**
 * Private zones settle before they count: someone entering a zone is treated as being on the
 * open floor for ZONE_SETTLE_MS, while leaving a zone takes effect immediately.
 */

const A = 'aaa-socket';
const B = 'bbb-socket';
const ZONE = 'zone-1';
const SETTLE_WAIT = 1100;

let room: Room;

beforeEach(() => {
  installMediaMocks();
  room = new Room();
});

afterEach(() => {
  for (const id of [...room.clients.keys()]) room.leave(id);
  vi.useRealTimers();
});

const peerOf = (client: PeerClient, socketId: string) => client.api.__debugPeers.get(socketId);
const isLinked = (client: PeerClient, socketId: string) => !!peerOf(client, socketId)?.link;
const cameraSender = (client: PeerClient) => client.created.videoSenders.find((s) => s.kind === 'camera' && !s.stopped);
const screenSender = (client: PeerClient) => client.created.videoSenders.find((s) => s.kind === 'screen' && !s.stopped);
const audioDatagramsTo = (client: PeerClient, socketId: string) =>
  ((peerOf(client, socketId)!.link as any).datagramsSent as Uint8Array[])
    .map((d) => decodePacket(d))
    .filter((p) => p?.kind === 'audio');

/** Fake timers swallow setTimeout-based settle(), so flush with the fake clock instead. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('zone settle', () => {
  it('walking through a zone does not churn the floor neighbour connection', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    room.join(makeUser({ socketId: B, position: { x: 2, y: 1 } }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    expect(cam.subscriberIds).toEqual([B]);

    vi.useFakeTimers();
    room.move(B, 2, 1, ZONE);
    await flush();
    // Still on the floor at the same spot: not a member yet, but still in range.
    expect(cam.subscriberIds).toEqual([B]);

    await vi.advanceTimersByTimeAsync(SETTLE_WAIT);
    expect(cam.subscriberIds).toEqual([]);
  });

  it('connects zone members only once they have settled', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 30, y: 30 } }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    expect(cam.subscriberIds).toEqual([]);

    vi.useFakeTimers();
    room.move(A, 1, 1, ZONE);
    room.move(B, 30, 30, ZONE);
    await flush();
    expect(cam.subscriberIds).toEqual([]);

    await vi.advanceTimersByTimeAsync(SETTLE_WAIT);
    expect(cam.subscriberIds).toEqual([B]);
    cam.frame(true);
    await flush();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);
  });

  it('leaving a zone is immediate', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 }, currentZoneId: ZONE }), 'a');
    room.join(makeUser({ socketId: B, position: { x: 2, y: 1 }, currentZoneId: ZONE }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    expect(cam.subscriberIds).toEqual([B]);

    vi.useFakeTimers();
    room.move(B, 30, 30, null);
    await flush();
    expect(cam.subscriberIds).toEqual([]);
  });

  describe('screen share', () => {
    it('stays inside the zone: no one outside gets it, members get it once settled', async () => {
      const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 }, currentZoneId: ZONE }), 'a');
      const b = room.join(makeUser({ socketId: B, position: { x: 30, y: 30 } }), 'b');
      await settle();
      await a.api.toggleScreenShare();
      await settle();
      const screen = screenSender(a)!;
      expect(screen.subscriberIds).toEqual([]);

      vi.useFakeTimers();
      room.move(B, 2, 1, ZONE);
      await flush();
      expect(screen.subscriberIds).toEqual([]);

      await vi.advanceTimersByTimeAsync(SETTLE_WAIT);
      expect(screen.subscriberIds).toEqual([B]);

      room.move(B, 30, 30, null);
      await flush();
      expect(screen.subscriberIds).toEqual([]);
      expect(b.api.remoteScreenStreams.value.has(A)).toBe(false);
    });

    it('a floor sharer reaches the whole floor with no distance limit', async () => {
      const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
      room.join(makeUser({ socketId: B, position: { x: 40, y: 40 } }), 'b');
      await settle();
      await a.api.toggleScreenShare();
      await settle();
      expect(screenSender(a)!.subscriberIds).toEqual([B]);
    });

    it('a sharer still settling inside a zone does not send to the floor', async () => {
      const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
      room.join(makeUser({ socketId: B, position: { x: 40, y: 40 } }), 'b');
      await settle();
      vi.useFakeTimers();
      room.move(A, 1, 1, ZONE);
      await flush();
      await a.api.toggleScreenShare();
      await flush();
      expect(screenSender(a)!.subscriberIds).toEqual([]);

      await vi.advanceTimersByTimeAsync(SETTLE_WAIT);
      expect(screenSender(a)!.subscriberIds).toEqual([]);
    });
  });

  it('a user who joins directly into a zone counts as settled', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 }, currentZoneId: ZONE }), 'a');
    room.join(makeUser({ socketId: B, position: { x: 2, y: 1 }, currentZoneId: ZONE }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();
    expect(cameraSender(a)!.subscriberIds).toEqual([B]);
  });

  it('audio reaches a peer still settling inside a zone, but stops once they settle elsewhere', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 2, y: 1 } }), 'b');
    await settle();
    await a.api.initLocalAudio();
    const sender = a.created.audioSenders[0];
    sender.frame();
    await settle();
    expect(b.api.__debugRemoteAudio.get(A)).toBeDefined();
    expect(audioDatagramsTo(a, B)).toHaveLength(1);

    // B walks into a zone A is not in: still on the floor while settling, so audio goes on.
    vi.useFakeTimers();
    room.move(B, 2, 1, 'zone-2');
    await flush();
    sender.frame();
    await flush();
    expect(audioDatagramsTo(a, B)).toHaveLength(2);

    // Once settled in a zone A isn't in, nothing is sent.
    await vi.advanceTimersByTimeAsync(SETTLE_WAIT);
    sender.frame();
    await flush();
    expect(audioDatagramsTo(a, B)).toHaveLength(2);
  });
});
