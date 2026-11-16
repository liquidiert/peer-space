import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePacket } from '../src/lib/media/wire';
import type { FakeLink } from './helpers/fakeIroh';
import { installMediaMocks } from './helpers/fakeMedia';
import { makeUser, Room, settle, type PeerClient } from './helpers/peerHarness';

/**
 * Races between video subscription changes and the stream messages still in flight on the
 * real transport: a closed camera stream drains its queued frames after a 'stopped' control
 * message has already reached the receiver. Frames for a stopped stream must not resurrect a
 * tile, and a late 'stopped' must not kill the stream that replaced it.
 */

const A = 'aaa-socket';
const B = 'bbb-socket';

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
const cameraSender = (client: PeerClient) => client.created.videoSenders.find((s) => s.kind === 'camera' && !s.stopped);
const isControl = (d: Uint8Array) => decodePacket(d)?.kind === 'control';
const isVideo = (d: Uint8Array) => decodePacket(d)?.kind === 'video';
/** A's outgoing side of the link to B: where held messages from A to B sit. */
const linkAtoB = (a: PeerClient) => peerOf(a, B)!.link as FakeLink;

async function joinTwo(posB = { x: 1, y: 1 }) {
  const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
  const b = room.join(makeUser({ socketId: B, position: posB }), 'b');
  await settle();
  return { a, b };
}

describe('video subscription races over iroh', () => {
  it('leaving a private zone boundary leaves no ghost tile when frames drain after \'stopped\'', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true);
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);

    // A keyframe is still in flight on the camera stream when B walks into the zone.
    linkAtoB(a).holdStreams = true;
    cam.frame(true);
    vi.useFakeTimers();
    room.move(B, 2, 1, 'zone-1');
    await vi.advanceTimersByTimeAsync(1100);
    expect(cam.subscriberIds).toEqual([]);
    vi.useRealTimers();
    await settle();

    // The control stream overtakes the video that was sent before it.
    linkAtoB(a).releaseHeld(isControl);
    await settle();
    linkAtoB(a).releaseHeld(isVideo);
    await settle();

    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);
    expect(b.created.receivers.filter((r) => !r.closed)).toHaveLength(0);
  });

  it('fast leave and re-enter keeps the new stream when \'stopped\' arrives late', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true);
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);

    // Old stream: a frame and the 'stopped' for it are both still in flight.
    linkAtoB(a).holdStreams = true;
    cam.frame(true);
    vi.useFakeTimers();
    room.move(B, 2, 1, 'zone-1');
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await settle();

    // Back in range right away: a new stream opens and sends its keyframe.
    room.move(B, 2, 1, null);
    await settle();
    expect(cam.subscriberIds).toEqual([B]);
    cam.frame(true);

    // The new keyframe overtakes the old 'stopped'.
    linkAtoB(a).releaseHeld(isVideo);
    await settle();
    linkAtoB(a).releaseHeld(isControl);
    await settle();

    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);
    const latest = b.created.receivers.at(-1)!;
    expect(latest.closed).toBe(false);

    // A delta on the new stream must reach the receiver that is still showing the tile.
    linkAtoB(a).holdStreams = false;
    cam.frame(false);
    await settle();
    expect(latest.packets.at(-1)!.key).toBe(false);
  });

  it('a drained frame from the old stream, arriving after the new keyframe, does not kill the new stream', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true); // seq 0, delivered normally
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);

    // Old stream: seq 1 is still queued when B walks into the zone (stopped carries next seq 2).
    linkAtoB(a).holdStreams = true;
    cam.frame(true);
    vi.useFakeTimers();
    room.move(B, 2, 1, 'zone-1');
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await settle();

    // Back in range: the new stream's keyframe is seq 2.
    room.move(B, 2, 1, null);
    await settle();
    cam.frame(true);

    // Arrival order: new keyframe (seq 2), then the drained old frame (seq 1), then 'stopped' (2).
    const seqOf = (d: Uint8Array) => {
      const p = decodePacket(d);
      return p?.kind === 'video' ? p.seq : undefined;
    };
    linkAtoB(a).releaseHeld((d) => seqOf(d) === 2);
    await settle();
    linkAtoB(a).releaseHeld((d) => seqOf(d) === 1);
    await settle();
    linkAtoB(a).releaseHeld(isControl);
    await settle();

    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);
    const latest = b.created.receivers.at(-1)!;
    expect(latest.closed).toBe(false);

    linkAtoB(a).holdStreams = false;
    cam.frame(false);
    await settle();
    expect(latest.packets.at(-1)!.key).toBe(false);
  });

  it('turning the camera off leaves no ghost tile when frames drain after \'stopped\'', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true);
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);

    linkAtoB(a).holdStreams = true;
    cam.frame(true);
    await a.api.toggleCamera();
    await settle();

    linkAtoB(a).releaseHeld(isControl);
    await settle();
    linkAtoB(a).releaseHeld(isVideo);
    await settle();

    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);
    expect(b.created.receivers.filter((r) => !r.closed)).toHaveLength(0);
  });

  it('camera off then on again shows the new camera', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    cameraSender(a)!.frame(true);
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);

    await a.api.toggleCamera();
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);

    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true);
    await settle();

    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);
    const latest = b.created.receivers.at(-1)!;
    expect(latest.closed).toBe(false);
    expect(latest.packets.at(-1)!.key).toBe(true);
  });
});
