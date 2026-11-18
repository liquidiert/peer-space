import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePacket } from '../src/lib/media/wire';
import { installMediaMocks } from './helpers/fakeMedia';
import { makeUser, Room, settle, type PeerClient } from './helpers/peerHarness';

/**
 * Maps share one coordinate space, so two people on different maps can stand on the same x,y.
 * Someone on another map must never get audio, camera or screen share, and a map change must
 * connect or tear down links the same way a position change does.
 */

const A = 'aaa-socket';
const B = 'bbb-socket';
const OFFICE = 'space1:office_default';
const RACE = 'space1:race_track';

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
const volumeOf = (client: PeerClient, socketId: string) =>
  client.api.calculateProximityVolume(client.users.value.find((u) => u.socketId === socketId)!);

describe('map scoping of proximity media', () => {
  it('connects nothing to someone on another map at the same coordinates', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 }, mapId: OFFICE }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 1, y: 1 }, mapId: RACE }), 'b');
    await settle();
    await a.api.initLocalAudio();
    await a.api.toggleCamera();
    await a.api.toggleScreenShare();
    await settle();

    expect(peerOf(a, B)).toBeUndefined();
    expect(peerOf(b, A)).toBeUndefined();
    expect(volumeOf(a, B)).toBe(0);
    expect(volumeOf(b, A)).toBe(0);
    expect(cameraSender(a)!.subscriberIds).toEqual([]);
    expect(screenSender(a)!.subscriberIds).toEqual([]);

    a.created.audioSenders[0].frame();
    await settle();
    expect(b.api.__debugRemoteAudio.get(A)).toBeUndefined();
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);
    expect(b.api.remoteScreenStreams.value.has(A)).toBe(false);
  });

  it('connects once both are on the same map, and tears down when one leaves it', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 }, mapId: OFFICE }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 1, y: 1 }, mapId: RACE }), 'b');
    await settle();
    await a.api.initLocalAudio();
    await a.api.toggleCamera();
    await a.api.toggleScreenShare();
    await settle();
    expect(isLinked(a, B)).toBe(false);

    room.update(B, { mapId: OFFICE });
    await settle();
    expect(isLinked(a, B)).toBe(true);
    expect(volumeOf(a, B)).toBeGreaterThan(0);
    expect(cameraSender(a)!.subscriberIds).toEqual([B]);
    expect(screenSender(a)!.subscriberIds).toEqual([B]);

    a.created.audioSenders[0].frame();
    await settle();
    expect(b.api.__debugRemoteAudio.get(A)).toBeDefined();

    room.update(B, { mapId: RACE });
    await settle();
    expect(isLinked(a, B)).toBe(false);
    expect(volumeOf(a, B)).toBe(0);
    expect(cameraSender(a)!.subscriberIds).toEqual([]);
    expect(screenSender(a)!.subscriberIds).toEqual([]);
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);
    expect(b.api.remoteScreenStreams.value.has(A)).toBe(false);
  });

  it('reconciles on a map change alone, without a fresh user list from the server', async () => {
    // Connected on the same map first.
    const a = room.join(makeUser({ socketId: A, position: { x: 1, y: 1 }, mapId: OFFICE }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 2, y: 1 }, mapId: OFFICE }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();
    expect(isLinked(a, B)).toBe(true);
    expect(cameraSender(a)!.subscriberIds).toEqual([B]);

    // A moves to the race track; B stays put. Both clients learn of it by direct state writes,
    // with no syncPeerConnections call from the harness: only the composable's watchers can react.
    a.currentUser.value = { ...a.currentUser.value, mapId: RACE };
    b.users.value = b.users.value.map((u) => (u.socketId === A ? { ...u, mapId: RACE } : u));
    await settle();

    expect(isLinked(a, B)).toBe(false);
    expect(cameraSender(a)!.subscriberIds).toEqual([]);
    expect(volumeOf(a, B)).toBe(0);
  });
});

describe('map-wide media (race track)', () => {
  // Tiles 60 apart: far beyond the 4-tile floor range, but on the same map.
  const FAR = 60;

  it('gives full volume and camera video to everyone on a mapWideMedia map, whatever the distance', async () => {
    room.setMapWide(RACE, true);
    const a = room.join(makeUser({ socketId: A, position: { x: 2, y: 1 }, mapId: RACE }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 2 + FAR, y: 1 }, mapId: RACE }), 'b');
    await settle();
    await a.api.initLocalAudio();
    await a.api.toggleCamera();
    await settle();

    expect(isLinked(a, B)).toBe(true);
    expect(volumeOf(a, B)).toBe(1);
    expect(cameraSender(a)!.subscriberIds).toEqual([B]);

    a.created.audioSenders[0].frame();
    await settle();
    expect(b.api.__debugRemoteAudio.get(A)).toBeDefined();
  });

  it('keeps the distance limit on an ordinary map at the same distance', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 2, y: 1 }, mapId: OFFICE }), 'a');
    room.join(makeUser({ socketId: B, position: { x: 2 + FAR, y: 1 }, mapId: OFFICE }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();

    expect(volumeOf(a, B)).toBe(0);
    expect(cameraSender(a)!.subscriberIds).toEqual([]);
  });

  it('still never links users on different maps when one of the maps is mapWideMedia', async () => {
    room.setMapWide(RACE, true);
    const a = room.join(makeUser({ socketId: A, position: { x: 2, y: 1 }, mapId: RACE }), 'a');
    const b = room.join(makeUser({ socketId: B, position: { x: 2, y: 1 }, mapId: OFFICE }), 'b');
    await settle();
    await a.api.initLocalAudio();
    await a.api.toggleCamera();
    await settle();

    expect(peerOf(a, B)).toBeUndefined();
    expect(peerOf(b, A)).toBeUndefined();
    expect(volumeOf(a, B)).toBe(0);
    expect(volumeOf(b, A)).toBe(0);
    expect(cameraSender(a)!.subscriberIds).toEqual([]);
    expect(b.api.remoteVideoStreams.value.has(A)).toBe(false);
  });

  it('keeps private zones in force: a floor user far away gets nothing, a zone-mate far away gets everything', async () => {
    room.setMapWide(RACE, true);
    const ZONE = 'pit-zone';
    const inZone = room.join(makeUser({ socketId: A, position: { x: 2, y: 1 }, mapId: RACE, currentZoneId: ZONE }), 'a');
    const zoneMate = room.join(makeUser({ socketId: B, position: { x: 2 + FAR, y: 1 }, mapId: RACE, currentZoneId: ZONE }), 'b');
    room.join(makeUser({ socketId: 'ccc-socket', position: { x: 2 + FAR, y: 2 }, mapId: RACE }), 'c');
    await settle();
    await inZone.api.toggleCamera();
    await settle();

    // Same zone, far apart: in range. The floor user at the same distance: out of range.
    expect(volumeOf(inZone, B)).toBe(1);
    expect(volumeOf(inZone, 'ccc-socket')).toBe(0);
    expect(cameraSender(inZone)!.subscriberIds).toEqual([B]);
    expect(volumeOf(zoneMate, 'ccc-socket')).toBe(0);
  });

  it('keeps the floor in map-wide range while a zone-mate stays out of it', async () => {
    room.setMapWide(RACE, true);
    const ZONE = 'pit-zone';
    const inZone = room.join(makeUser({ socketId: A, position: { x: 2, y: 1 }, mapId: RACE, currentZoneId: ZONE }), 'a');
    const floor = room.join(makeUser({ socketId: B, position: { x: 2 + FAR, y: 1 }, mapId: RACE }), 'b');
    await settle();
    await inZone.api.toggleCamera();
    await settle();

    expect(volumeOf(inZone, B)).toBe(0);
    expect(cameraSender(inZone)!.subscriberIds).toEqual([]);
    expect(volumeOf(floor, A)).toBe(0);
  });

  it('reconciles when the map flag flips while both stay put', async () => {
    const a = room.join(makeUser({ socketId: A, position: { x: 2, y: 1 }, mapId: OFFICE }), 'a');
    room.join(makeUser({ socketId: B, position: { x: 2 + FAR, y: 1 }, mapId: OFFICE }), 'b');
    await settle();
    await a.api.toggleCamera();
    await settle();
    expect(cameraSender(a)!.subscriberIds).toEqual([]);

    room.setMapWide(OFFICE, true);
    await settle();
    expect(volumeOf(a, B)).toBe(1);
    expect(cameraSender(a)!.subscriberIds).toEqual([B]);

    room.setMapWide(OFFICE, false);
    await settle();
    expect(volumeOf(a, B)).toBe(0);
    expect(cameraSender(a)!.subscriberIds).toEqual([]);
  });
});
