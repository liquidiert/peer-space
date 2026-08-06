import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('does not leave a stale video tile behind once a peer actually leaves', async () => {
    // Regression test: removePeerConnection previously cleaned up peerConnections,
    // remoteAudioElements and pendingCandidates, but never remoteVideoStreams - so once
    // someone left (or their connection was torn down for any reason), their video tile
    // stayed frozen in the dock forever, since nothing ever deleted that map entry.
    const users = usersInRange();
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

    expect(a.api.remoteVideoStreams.value.has(B), 'A should see B\'s video before B leaves').toBe(true);

    // B actually leaves (not just an ICE hiccup) - A must not attempt to reconnect.
    a.users.value = a.users.value.filter((u) => u.socketId !== B);
    a.api.syncPeerConnections();
    await settle();

    expect(
      a.api.remoteVideoStreams.value.has(B),
      'video tile must be removed once the peer has actually left'
    ).toBe(false);
    expect(peerConnectionTo(a, B), 'the underlying connection should be gone too').toBeFalsy();

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

  it('drops a screen tile once the sharer is no longer flagged as sharing', async () => {
    // A sharer whose share ends without a clean track-ended event - suspended/discarded tab,
    // crashed renderer - used to leave the last frame frozen in every viewer's dock. The
    // broadcast isScreenSharing flag is the reliable signal that it's over.
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    await a.api.toggleScreenShare();
    await settle();

    expect(b.api.remoteScreenStreams.value.has(A), 'B should see A\'s shared screen').toBe(true);

    // The server broadcasts A's profile update; everyone's user list now says A is sharing.
    const sharing = (flag: boolean) => (u: any) => (u.socketId === A ? { ...u, isScreenSharing: flag } : u);
    b.users.value = b.users.value.map(sharing(true));
    await settle();
    expect(b.api.remoteScreenStreams.value.has(A), 'tile must survive routine user updates').toBe(true);

    // A's share stops without the track ever ending on B's side.
    b.users.value = b.users.value.map(sharing(false));
    await settle();

    expect(
      b.api.remoteScreenStreams.value.has(A),
      'stale screen tile must be dropped once the sharer stops sharing'
    ).toBe(false);

    a.destroy();
    b.destroy();
  });

  it('warns the user when a peer connection stays broken', async () => {
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    expect(a.api.hasConnectionTrouble.value).toBe(false);

    // shouldAdvanceTime keeps the harness's real setTimeout(0) plumbing working while still
    // letting the test jump the clock past the grace period.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      peerConnectionTo(a, B).emitConnectionState('failed');
      await settle();

      // A single failure is just a routine rebuild - warning the user here would fire on
      // every transient blip.
      expect(a.api.hasConnectionTrouble.value).toBe(false);

      // The rebuilt connection never comes up either.
      vi.advanceTimersByTime(9000);
      expect(a.api.hasConnectionTrouble.value).toBe(true);
      expect(a.api.troubledPeerIds.value).toContain(B);

      // ...and the warning clears as soon as it recovers.
      peerConnectionTo(a, B).emitConnectionState('connected');
      expect(a.api.hasConnectionTrouble.value).toBe(false);
      expect(a.api.troubledPeerIds.value).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }

    a.destroy();
    b.destroy();
  });

  it('stops warning about a peer that has left rather than one that is broken', async () => {
    const users = usersInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);

    await giveAudio(a);
    await giveAudio(b);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    await settle();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // B leaves, then their connection reports the failure that leaving caused.
      const pc = peerConnectionTo(a, B);
      a.users.value = a.users.value.filter((u) => u.socketId !== B);
      a.api.syncPeerConnections();
      await settle();

      pc.emitConnectionState('failed');
      vi.advanceTimersByTime(9000);

      expect(
        a.api.hasConnectionTrouble.value,
        'someone leaving is not a connection problem to warn about'
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    a.destroy();
    b.destroy();
  });
});

describe('multi-participant streaming (3+ people)', () => {
  const C = 'ccc-socket';

  beforeEach(() => {
    installWebRTCMocks();
    bus = new SignalBus();
  });

  function usersAllInRange() {
    return [
      makeUser({ socketId: A, position: { x: 1, y: 1 } }),
      makeUser({ socketId: B, position: { x: 1, y: 1 } }),
      makeUser({ socketId: C, position: { x: 1, y: 1 } }),
    ];
  }

  it('forms a full audio+video mesh between all three participants', async () => {
    const users = usersAllInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);
    const c = createPeerClient(bus, C, users);

    await giveAudio(a);
    await giveAudio(b);
    await giveAudio(c);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    c.api.syncPeerConnections();
    await settle();

    await giveCamera(a);
    await giveCamera(b);
    await giveCamera(c);
    await settle();

    // Every participant should end up with a working connection - and therefore a video
    // tile - for both of the other two, not just the one they happened to connect to first.
    const pairs: [PeerClient, string][] = [
      [a, B], [a, C],
      [b, A], [b, C],
      [c, A], [c, B],
    ];
    for (const [client, otherId] of pairs) {
      expect(
        client.api.remoteVideoStreams.value.has(otherId),
        `${client.socketId} should see ${otherId}'s video`
      ).toBe(true);
    }

    a.destroy();
    b.destroy();
    c.destroy();
  });

  it('keeps the other two working when one participant reloads (new socket id)', async () => {
    const users = usersAllInRange();
    const a = createPeerClient(bus, A, users);
    const b = createPeerClient(bus, B, users);
    const c = createPeerClient(bus, C, users);

    await giveAudio(a);
    await giveAudio(b);
    await giveAudio(c);
    a.api.syncPeerConnections();
    b.api.syncPeerConnections();
    c.api.syncPeerConnections();
    await settle();

    await giveCamera(a);
    await giveCamera(b);
    await giveCamera(c);
    await settle();

    // B "reloads": their old socket disappears entirely first (mirrors the server
    // emitting user:left to everyone else, independent of any WebRTC-layer failure
    // detection) - and only afterwards does a new socket for B rejoin and get
    // broadcast as user:joined. Modeling these as two distinct phases (rather than
    // syncing A/C against a user list containing B2 before B2's socket even exists)
    // matters: in the real app, the server never announces a peer until its socket
    // connection is already live, so there's no window to race against.
    b.destroy();
    const B2 = 'bbb-socket-reloaded';
    const withoutB = [makeUser({ socketId: A, position: { x: 1, y: 1 } }), makeUser({ socketId: C, position: { x: 1, y: 1 } })];
    a.users.value = withoutB;
    c.users.value = withoutB;
    a.api.syncPeerConnections();
    c.api.syncPeerConnections();
    await settle();

    // A and C's connection to each other must be completely unaffected by B's reload.
    expect(a.api.remoteVideoStreams.value.has(C), 'A-C video should survive B reloading').toBe(true);
    expect(c.api.remoteVideoStreams.value.has(A), 'C-A video should survive B reloading').toBe(true);
    // And the stale entry for B's old socket id must not linger as a ghost tile.
    expect(a.api.remoteVideoStreams.value.has(B), 'no ghost tile for the old B socket').toBe(false);
    expect(c.api.remoteVideoStreams.value.has(B), 'no ghost tile for the old B socket').toBe(false);

    // Now B rejoins under a new socket id.
    const afterReload = [
      makeUser({ socketId: A, position: { x: 1, y: 1 } }),
      makeUser({ socketId: B2, position: { x: 1, y: 1 } }),
      makeUser({ socketId: C, position: { x: 1, y: 1 } }),
    ];
    const b2 = createPeerClient(bus, B2, afterReload);
    await giveAudio(b2);
    await giveCamera(b2);
    a.users.value = afterReload;
    c.users.value = afterReload;
    a.api.syncPeerConnections();
    c.api.syncPeerConnections();
    b2.api.syncPeerConnections();
    await settle();

    // B rejoining under the new id should reconnect to both A and C.
    expect(a.api.remoteVideoStreams.value.has(B2), 'A should see the rejoined B').toBe(true);
    expect(c.api.remoteVideoStreams.value.has(B2), 'C should see the rejoined B').toBe(true);
    expect(b2.api.remoteVideoStreams.value.has(A)).toBe(true);
    expect(b2.api.remoteVideoStreams.value.has(C)).toBe(true);

    a.destroy();
    b2.destroy();
    c.destroy();
  });
});
