import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePacket, toHex } from '../src/lib/media/wire';
import { installMediaMocks } from './helpers/fakeMedia';
import { makeUser, Room, settle, type PeerClient } from './helpers/peerHarness';

/**
 * Integration coverage for proximity audio/video over iroh: who connects to whom, which
 * peers get our audio and video, and recovery when connections or people go away.
 */

const A = 'aaa-socket';
const B = 'bbb-socket';
const C = 'ccc-socket';

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
const remoteAudioFor = (client: PeerClient, socketId: string) => client.api.__debugRemoteAudio.get(socketId) as any;
const cameraSender = (client: PeerClient) => client.created.videoSenders.find((s) => s.kind === 'camera' && !s.stopped);
const screenSender = (client: PeerClient) => client.created.videoSenders.find((s) => s.kind === 'screen' && !s.stopped);

async function joinTwo(posB = { x: 1, y: 1 }) {
  const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
  const b = room.join(makeUser({ socketId: B, position: posB }), 'b');
  await settle();
  return { a, b };
}

describe('proximity media over iroh', () => {
  it('announces a signed endpoint and connects the pair exactly once', async () => {
    const { a, b } = await joinTwo();

    expect(a.emitted.filter((e) => e.event === 'media:announce')).toHaveLength(1);
    expect(room.userList.every((u) => u.media)).toBe(true);
    expect(isLinked(a, B)).toBe(true);
    expect(isLinked(b, A)).toBe(true);
    // Only the lower endpoint id dials; the other side just accepts.
    expect(a.transport()!.dials).toEqual([b.transport()!.id]);
    expect(b.transport()!.dials).toEqual([]);
    expect(a.api.peerConnectionStates.value.get(B)).toBe('connected');
    expect(a.api.hasConnectionTrouble.value).toBe(false);
  });

  it('sends audio only to peers in earshot', async () => {
    const { a, b } = await joinTwo();
    await a.api.initLocalAudio();
    const sender = a.created.audioSenders[0];

    sender.frame();
    await settle();
    expect(remoteAudioFor(b, A).packets).toHaveLength(1);
    expect(remoteAudioFor(b, A).volume).toBe(1);

    // Walk away: nothing goes out over the link any more.
    room.move(B, 30, 30);
    await settle();
    const sent = (peerOf(a, B)!.link as any).datagramsSent.length;
    sender.frame();
    await settle();
    expect((peerOf(a, B)!.link as any).datagramsSent).toHaveLength(sent);
    expect(remoteAudioFor(b, A).packets).toHaveLength(1);
  });

  it('stops sending to a deafened peer, and sends nothing while muted', async () => {
    const { a, b } = await joinTwo();
    await a.api.initLocalAudio();
    const sender = a.created.audioSenders[0];

    room.update(B, { isDeafened: true });
    await settle();
    sender.frame();
    await settle();
    expect(remoteAudioFor(b, A)).toBeUndefined();

    room.update(B, { isDeafened: false });
    a.isMuted.value = true;
    await settle();
    sender.frame();
    await settle();
    expect(remoteAudioFor(b, A)).toBeUndefined();

    a.isMuted.value = false;
    await settle();
    sender.frame();
    await settle();
    expect(remoteAudioFor(b, A).packets).toHaveLength(1);
  });

  it('sends the camera only to peers in range and removes the tile when they leave it', async () => {
    const { a, b } = await joinTwo({ x: 30, y: 30 });
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    expect(cam.subscriberIds).toEqual([]);

    room.move(B, 2, 1);
    await settle();
    expect(cam.subscriberIds).toEqual([B]);
    cam.frame(true);
    await settle();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(true);

    // Into a private zone the other one isn't in: out of range regardless of distance.
    room.move(B, 2, 1, 'zone-1');
    await settle();
    expect(cam.subscriberIds).toEqual([]);
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);

    room.move(B, 2, 1, null);
    await settle();
    expect(cam.subscriberIds).toEqual([B]);

    await a.api.toggleCamera();
    await settle();
    expect(cam.stopped).toBe(true);
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);
  });

  it('asks the sender for a keyframe on behalf of a receiver that lost sync', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true);
    await settle();

    b.created.receivers[0].askForKey();
    await settle();
    expect(cam.keyframeRequests).toContain(B);
  });

  it('drops frames for a congested peer until the next keyframe', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    const cam = cameraSender(a)!;
    cam.frame(true);
    await settle();
    const receiver = b.created.receivers[0];

    (peerOf(a, B)!.link as any).congested = true;
    cam.frame(false);
    (peerOf(a, B)!.link as any).congested = false;
    cam.frame(false); // undecodable without the dropped one: must not be sent
    cam.frame(true);
    await settle();
    expect(receiver.packets.map((p) => p.key)).toEqual([true, true]);
  });

  it('shares the screen with everyone and drops the tile when sharing ends', async () => {
    const { a, b } = await joinTwo({ x: 40, y: 40 });
    await a.api.toggleScreenShare();
    await settle();
    const screen = screenSender(a)!;
    expect(screen.subscriberIds).toEqual([B]);
    screen.frame(true);
    await settle();
    expect(b.api.remoteScreenStreams.value.has(A)).toBe(true);

    // Native "Stop sharing" button.
    (screen.track as any).endTrack();
    await settle();
    expect(screen.stopped).toBe(true);
    expect(b.api.remoteScreenStreams.value.has(A)).toBe(false);
  });

  it('drops a screen tile once the sharer is no longer flagged as sharing, even without a stop message', async () => {
    const { a, b } = await joinTwo();
    await a.api.toggleScreenShare();
    await settle();
    screenSender(a)!.frame(true);
    await settle();
    expect(b.api.remoteScreenStreams.value.has(A)).toBe(true);

    // The sharer's tab died: only the server's flag changes.
    room.update(A, { isScreenSharing: false });
    await settle();
    expect(b.api.remoteScreenStreams.value.has(A)).toBe(false);
  });

  it('reconnects when a peer reloads with a new socket and endpoint', async () => {
    const { a } = await joinTwo();
    await a.api.toggleCamera();
    await settle();
    expect(isLinked(a, B)).toBe(true);

    room.leave(B);
    await settle();
    expect(peerOf(a, B)).toBeUndefined();
    expect(a.api.peerConnectionStates.value.has(B)).toBe(false);

    const b2 = room.join(makeUser({ socketId: 'bbb-socket-2', position: { x: 1, y: 1 } }), 'b');
    await settle();
    expect(isLinked(a, 'bbb-socket-2')).toBe(true);
    expect(isLinked(b2, A)).toBe(true);
    expect(cameraSender(a)!.subscriberIds).toEqual(['bbb-socket-2']);
  });

  it('accepts a link that arrives before the dialer\'s announce does', async () => {
    const b = room.join(makeUser({ socketId: B, position: { x: 1, y: 1 } }), 'b');
    await settle();
    // B's socket lags: A joins, sees B's announce and dials, before B has heard of A.
    room.freeze(B);
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    await settle();
    expect(peerOf(b, A)).toBeUndefined();
    expect(isLinked(a, B)).toBe(true);

    room.unfreeze(B);
    await settle();
    expect(isLinked(b, A)).toBe(true);
    expect(a.transport()!.dials).toHaveLength(1);
    expect(b.api.peerConnectionStates.value.get(A)).toBe('connected');
  });

  it('ignores an announce that is not signed by the endpoint it names', async () => {
    const { a } = await joinTwo();
    const c = room.join(makeUser({ socketId: C, position: { x: 1, y: 1 } }), 'c');
    await settle();

    // C claims B's endpoint (signed with its own key): a server can't tell, clients can.
    const forged = { ...room.userList.find((u) => u.socketId === B)!.media!, sig: toHex(c.transport()!.sign(new Uint8Array(4))) };
    room.update(C, { media: forged });
    await settle();
    expect(peerOf(a, C)).toBeUndefined();
    expect(isLinked(a, B)).toBe(true);
  });

  it('redials after the connection drops', async () => {
    const { a, b } = await joinTwo();
    vi.useFakeTimers();
    peerOf(a, B)!.link!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(isLinked(a, B)).toBe(false);
    expect(a.api.peerConnectionStates.value.get(B)).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(1500);
    expect(isLinked(a, B)).toBe(true);
    expect(isLinked(b, A)).toBe(true);
    expect(a.api.peerConnectionStates.value.get(B)).toBe('connected');
  });

  it('warns about a peer that stays unreachable, and stops once they leave', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    await settle();
    vi.useFakeTimers();
    const b = room.join(makeUser({ socketId: B, position: { x: 1, y: 1 } }), 'b');
    await vi.advanceTimersByTimeAsync(0);
    // B's relay becomes unreachable and the existing connection drops.
    room.net.unreachable.add(b.transport()!.id);
    peerOf(a, B)?.link?.close();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(isLinked(a, B)).toBe(false);
    expect(a.api.hasConnectionTrouble.value).toBe(true);
    expect(a.api.troubledPeerIds.value).toEqual([B]);

    room.leave(B);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.api.hasConnectionTrouble.value).toBe(false);
  });

  it('prompts for a tap while the audio context is suspended by autoplay policy', async () => {
    const { a, b } = await joinTwo();
    b.created.engine.suspended = true;
    await a.api.initLocalAudio();
    a.created.audioSenders[0].frame();
    await settle();
    expect(b.api.isAudioPlaybackBlocked.value).toBe(true);

    window.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(b.created.engine.resumed).toBe(1);
    expect(b.api.isAudioPlaybackBlocked.value).toBe(false);
  });

  it('applies per-user volume trims and the proximity toggle to remote audio', async () => {
    const { a, b } = await joinTwo({ x: 3, y: 1 });
    await a.api.initLocalAudio();
    a.created.audioSenders[0].frame();
    await settle();
    expect(remoteAudioFor(b, A).volume).toBe(0.5);

    b.api.setUserVolume(A, 0.5);
    expect(remoteAudioFor(b, A).volume).toBe(0.25);
    b.api.setProximityVolumeEnabled(false);
    expect(remoteAudioFor(b, A).volume).toBe(0.5);
    b.isDeafened.value = true;
    await settle();
    expect(remoteAudioFor(b, A).volume).toBe(0);
  });
});

describe('three participants', () => {
  it('forms a full mesh and only sends each camera to people in range', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 2, y: 1 } }), 'b');
    const c = room.join(makeUser({ socketId: C, position: { x: 30, y: 30 } }), 'c');
    await settle();

    for (const [x, others] of [
      [a, [B, C]],
      [b, [A, C]],
      [c, [A, B]],
    ] as const) {
      for (const o of others) expect(isLinked(x, o)).toBe(true);
    }

    await a.api.toggleCamera();
    await settle();
    expect(cameraSender(a)!.subscriberIds).toEqual([B]);

    // One encoder, fanned out: walking C into range adds a subscriber, not an encoder.
    room.move(C, 1, 2);
    await settle();
    expect(cameraSender(a)!.subscriberIds.sort()).toEqual([B, C]);
    expect(a.created.videoSenders).toHaveLength(1);
  });

  it('keeps the other two working when one participant leaves', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 } }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 2, y: 1 } }), 'b');
    room.join(makeUser({ socketId: C, position: { x: 1, y: 2 } }), 'c');
    await settle();
    await a.api.initLocalAudio();

    room.leave(C);
    await settle();
    a.created.audioSenders[0].frame();
    await settle();
    expect(isLinked(a, B)).toBe(true);
    expect(decodePacket((peerOf(a, B)!.link as any).datagramsSent.at(-1))?.kind).toBe('audio');
    expect(remoteAudioFor(b, A).packets).toHaveLength(1);
  });
});
