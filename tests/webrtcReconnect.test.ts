import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import {
  installWebRTCMocks,
  setAutoplayBlocked,
  FakeMediaStream,
  FakeMediaStreamTrack,
} from './helpers/fakeWebRTC';
import { SignalBus, createPeerClient, makeUser, type PeerClient } from './helpers/peerHarness';

/**
 * Integration coverage for proximity-driven audio/video (re)connection.
 *
 * Scenarios mirror the two situations that were reported as unstable:
 *  - moving between zones / in and out of proximity range
 *  - a peer fully reloading the page (new socket id, fresh media capture)
 */

const A = 'aaa-socket';
const B = 'bbb-socket';

let bus: SignalBus;

/** Both users on the open floor, standing on top of each other (well within range). */
function usersInRange() {
  return [
    makeUser({ socketId: A, position: { x: 1, y: 1 } }),
    makeUser({ socketId: B, position: { x: 1, y: 1 } }),
  ];
}

/** Both on the open floor but far apart (MAX_AUDIO_DISTANCE is 4 tiles). */
function usersOutOfRange() {
  return [
    makeUser({ socketId: A, position: { x: 0, y: 0 } }),
    makeUser({ socketId: B, position: { x: 30, y: 30 } }),
  ];
}

function setPosition(client: PeerClient, socketId: string, x: number, y: number) {
  if (client.currentUser.value.socketId === socketId) {
    client.currentUser.value = { ...client.currentUser.value, position: { x, y } };
  }
  client.users.value = client.users.value.map((u) =>
    u.socketId === socketId ? { ...u, position: { x, y } } : u
  );
}

function setZone(client: PeerClient, socketId: string, zoneId: string | null) {
  if (client.currentUser.value.socketId === socketId) {
    client.currentUser.value = { ...client.currentUser.value, currentZoneId: zoneId };
  }
  client.users.value = client.users.value.map((u) =>
    u.socketId === socketId ? { ...u, currentZoneId: zoneId } : u
  );
}

/** Attach a local audio stream the way initLocalAudio() would. */
async function giveAudio(client: PeerClient) {
  await client.api.initLocalAudio();
}

async function giveCamera(client: PeerClient) {
  await client.api.toggleCamera();
}

/** Let watchers + async signal handling settle. */
async function settle() {
  await nextTick();
  await bus.settle();
  await nextTick();
}

function peerConnectionTo(client: PeerClient, target: string) {
  return (client.api as any).__debugPeerConnections?.get(target);
}

function videoSenderCount(client: PeerClient, forPeer: string) {
  const pc = peerConnectionTo(client, forPeer);
  return pc ? pc.getSenders().filter((s: any) => s.track?.kind === 'video').length : 0;
}

describe('proximity audio/video reconnection', () => {
  beforeEach(() => {
    installWebRTCMocks();
    bus = new SignalBus();
  });

  it('negotiates audio between two peers that are in range', async () => {
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);

    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    // Exactly one side should drive the initial offer (deterministic tiebreak on socket id).
    expect(bus.signalsOfType('offer')).toHaveLength(1);
    expect(bus.signalsOfType('answer')).toHaveLength(1);
  });

  it('recovers when a peer reloads the page and rejoins with a new socket id', async () => {
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    // B reloads: old socket disappears, a brand new socket id joins.
    b.destroy();
    const B2 = 'zzz-new-socket';
    const rejoined = [makeUser({ socketId: A, position: { x: 1, y: 1 } }), makeUser({ socketId: B2, position: { x: 1, y: 1 } })];

    a.users.value = rejoined;
    a.api.syncPeerConnections();

    const b2 = createPeerClient(bus, B2, rejoined);
    await giveAudio(b2);
    b2.api.syncPeerConnections();

    bus.clearLog();
    await settle();

    // The pair must renegotiate so audio flows again after the reload.
    expect(bus.log.filter((m) => m.to === B2 || m.from === B2).length).toBeGreaterThan(0);
    expect(bus.signalsOfType('answer').length).toBeGreaterThan(0);

    a.destroy();
    b2.destroy();
  });

  it('connects video when peers walk into range and tears it down when they leave', async () => {
    const users = usersOutOfRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    await giveCamera(a);
    await settle();

    // Out of range: camera is on locally, but no video track should be attached yet.
    expect(a.api.isVideoOn.value).toBe(true);
    expect(videoSenderCount(a, B)).toBe(0);

    // Walk B next to A - both watchers (a's and b's) fire, so both may attempt to
    // renegotiate; that's fine as long as it converges (asserted below), but only a's
    // outgoing video track is under test here.
    bus.clearLog();
    setPosition(a, B, 1, 1);
    setPosition(a, A, 1, 1);
    setPosition(b, B, 1, 1);
    setPosition(b, A, 1, 1);
    await settle();

    expect(bus.signalsOfType('offer').length).toBeGreaterThan(0);
    expect(videoSenderCount(a, B)).toBe(1);
    expect(peerConnectionTo(a, B).signalingState).toBe('stable');

    // Walk B far away again - the video sender should be dropped and renegotiated.
    bus.clearLog();
    setPosition(a, B, 40, 40);
    setPosition(b, B, 40, 40);
    await settle();

    expect(bus.signalsOfType('offer').length).toBeGreaterThan(0);
    expect(videoSenderCount(a, B)).toBe(0);
    expect(peerConnectionTo(a, B).signalingState).toBe('stable');

    a.destroy();
    b.destroy();
  });

  it('drops video when one peer enters a private zone and the other stays outside it', async () => {
    // Standing on the same tile, but zone isolation overrides raw distance (see
    // isWithinProximityRange): being in different zones (or only one of the two) always
    // counts as out of range, regardless of how close together the avatars are.
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    await giveCamera(a);
    await settle();
    expect(videoSenderCount(a, B)).toBe(1);

    // A walks into a private zone; B does not follow.
    bus.clearLog();
    setZone(a, A, 'zone-1');
    setZone(b, A, 'zone-1');
    await settle();

    expect(videoSenderCount(a, B)).toBe(0);
    expect(peerConnectionTo(a, B).signalingState).toBe('stable');

    // B joins the same zone - video should come back.
    bus.clearLog();
    setZone(a, B, 'zone-1');
    setZone(b, B, 'zone-1');
    await settle();

    expect(videoSenderCount(a, B)).toBe(1);
    expect(peerConnectionTo(a, B).signalingState).toBe('stable');

    a.destroy();
    b.destroy();
  });

  it('does not break negotiation when both peers move into range simultaneously (glare)', async () => {
    const users = usersOutOfRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    await giveCamera(a);
    await giveCamera(b);
    await settle();

    // Both clients observe the other entering range at the same instant, so both will
    // attempt to renegotiate before either has seen the other's offer.
    bus.paused = true;
    setPosition(a, A, 1, 1);
    setPosition(a, B, 1, 1);
    setPosition(b, A, 1, 1);
    setPosition(b, B, 1, 1);
    await nextTick();
    bus.releaseQueued();
    await settle();

    // Both connections must end up back in a usable state, not wedged mid-negotiation
    // (e.g. stuck in 'have-local-offer' because a second offer was rejected and never retried).
    expect(peerConnectionTo(a, B).signalingState).toBe('stable');
    expect(peerConnectionTo(b, A).signalingState).toBe('stable');
    expect(videoSenderCount(a, B)).toBe(1);
    expect(videoSenderCount(b, A)).toBe(1);

    a.destroy();
    b.destroy();
  });

  it('re-establishes the connection after a transient ICE disconnect', async () => {
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    const pc = peerConnectionTo(a, B);
    expect(pc).toBeTruthy();

    bus.clearLog();
    pc.emitConnectionState('failed');
    await settle();

    // Nothing outside the WebRTC layer changed (no one joined/left, position didn't move),
    // so the only way this recovers is if the composable itself retries after a failure.
    const recovered = peerConnectionTo(a, B);
    expect(recovered, 'expected a fresh peer connection to be (re)established after failure').toBeTruthy();
    expect(recovered.signalingState).not.toBe('closed');

    a.destroy();
    b.destroy();
  });

  it('sends audio even when the mic is captured after the peer connection is created', async () => {
    // Models a page refresh: init:state (and therefore syncPeerConnections) can arrive
    // before the getUserMedia permission promise resolves.
    const media = installWebRTCMocks({ deferUserMedia: true });
    bus = new SignalBus();

    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    const audioPromise = a.api.initLocalAudio();

    // Peer connections get built while the mic is still pending.
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    media.resolveUserMediaWith(new FakeMediaStream([new FakeMediaStreamTrack('audio')]));
    await audioPromise;
    await settle();

    const pc = peerConnectionTo(a, B);
    const audioSenders = pc.getSenders().filter((s: any) => s.track?.kind === 'audio');
    expect(audioSenders.length, 'local mic track must be attached to the existing connection').toBe(1);

    a.destroy();
    b.destroy();
  });

  it('recovers audio blocked by the browser autoplay policy after a user gesture', async () => {
    // Reproduces "I can see they're talking but can't hear anything": the remote track
    // arrives and is wired up correctly, but audio.play() is rejected by the browser
    // because it wasn't called inside a direct user-gesture handler.
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    setAutoplayBlocked(true);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    expect(a.api.isAudioPlaybackBlocked.value).toBe(true);

    // Still blocked - nothing magically fixes itself without a gesture.
    a.api.unlockBlockedAudioPlayback();
    await settle();
    expect(a.api.isAudioPlaybackBlocked.value).toBe(true);

    // A user gesture (tap/click) arrives - playback should recover.
    setAutoplayBlocked(false);
    a.api.unlockBlockedAudioPlayback();
    await settle();
    expect(a.api.isAudioPlaybackBlocked.value).toBe(false);

    a.destroy();
    b.destroy();
  });
});
