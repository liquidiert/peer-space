import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBearer, isEndpointIdHex, RelayAccessRegistry } from '../src/lib/relayAccess';
import { installMediaMocks } from './helpers/fakeMedia';
import { makeUser, Room, settle } from './helpers/peerHarness';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = '0123456789abcdef'.repeat(4);

describe('isEndpointIdHex', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isEndpointIdHex(ID_A)).toBe(true);
    expect(isEndpointIdHex(ID_C)).toBe(true);
  });

  it('rejects wrong lengths, non-hex characters, uppercase and non-strings', () => {
    expect(isEndpointIdHex('a'.repeat(63))).toBe(false);
    expect(isEndpointIdHex('a'.repeat(65))).toBe(false);
    expect(isEndpointIdHex('')).toBe(false);
    expect(isEndpointIdHex('g'.repeat(64))).toBe(false);
    expect(isEndpointIdHex(` ${'a'.repeat(63)}`)).toBe(false);
    expect(isEndpointIdHex('A'.repeat(64))).toBe(false);
    expect(isEndpointIdHex(undefined)).toBe(false);
    expect(isEndpointIdHex(null)).toBe(false);
  });
});

describe('RelayAccessRegistry', () => {
  it('admits an id only after it is registered for a socket', () => {
    const reg = new RelayAccessRegistry();
    expect(reg.allows(ID_A)).toBe(false);
    expect(reg.register('s1', ID_A)).toBe(true);
    expect(reg.allows(ID_A)).toBe(true);
    expect(reg.allows(ID_B)).toBe(false);
  });

  it('refuses invalid ids without admitting them', () => {
    const reg = new RelayAccessRegistry();
    expect(reg.register('s1', 'not-an-id')).toBe(false);
    expect(reg.register('s1', 'A'.repeat(64))).toBe(false);
    expect(reg.allows('not-an-id')).toBe(false);
  });

  it('replaces the id when a socket registers again, and drops the old one', () => {
    const reg = new RelayAccessRegistry();
    reg.register('s1', ID_A);
    expect(reg.register('s1', ID_B)).toBe(true);
    expect(reg.allows(ID_A)).toBe(false);
    expect(reg.allows(ID_B)).toBe(true);
    // The freed id can now be taken by another socket.
    expect(reg.register('s2', ID_A)).toBe(true);
  });

  it('keeps the id when a socket re-registers the same id', () => {
    const reg = new RelayAccessRegistry();
    reg.register('s1', ID_A);
    expect(reg.register('s1', ID_A)).toBe(true);
    expect(reg.allows(ID_A)).toBe(true);
  });

  it('removes the id on unregister, and only for that socket', () => {
    const reg = new RelayAccessRegistry();
    reg.register('s1', ID_A);
    reg.unregister('s1');
    expect(reg.allows(ID_A)).toBe(false);
    // Unregistering a socket that never registered is a no-op.
    reg.unregister('nobody');
  });

  it('does not let a stale unregister remove an id another socket now holds', () => {
    const reg = new RelayAccessRegistry();
    reg.register('s1', ID_A);
    reg.unregister('s1');
    reg.register('s2', ID_A);
    reg.unregister('s1');
    expect(reg.allows(ID_A)).toBe(true);
  });

  it('refuses an id another socket holds', () => {
    const reg = new RelayAccessRegistry();
    reg.register('s1', ID_A);
    expect(reg.register('s2', ID_A)).toBe(false);
    expect(reg.allows(ID_A)).toBe(true);
    // The holder's own registration is unaffected.
    reg.unregister('s2');
    expect(reg.allows(ID_A)).toBe(true);
  });
});

describe('checkBearer', () => {
  const TOKEN = 'secret-token-123';

  it('accepts the exact Bearer token', () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(checkBearer(`Bearer ${'x'.repeat(TOKEN.length)}`, TOKEN)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkBearer(undefined, TOKEN)).toBe(false);
    expect(checkBearer('', TOKEN)).toBe(false);
  });

  it('rejects the token without the Bearer scheme', () => {
    expect(checkBearer(TOKEN, TOKEN)).toBe(false);
    expect(checkBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });

  it('rejects a token of a different length, including a prefix or extension of it', () => {
    expect(checkBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(checkBearer(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(checkBearer('Bearer ', TOKEN)).toBe(false);
  });

  it('never matches when the configured token is empty', () => {
    expect(checkBearer('Bearer ', '')).toBe(false);
    expect(checkBearer('Bearer x', '')).toBe(false);
  });
});

describe('media:register ordering on the client', () => {
  let room: Room;

  beforeEach(() => {
    installMediaMocks();
    room = new Room();
  });

  afterEach(() => {
    for (const id of [...room.clients.keys()]) room.leave(id);
  });

  it('registers the transport id with the server before announcing it', async () => {
    const a = room.join(makeUser({ socketId: 'aaa-socket' }), 'a');
    await settle();

    const id = a.transport()!.id;
    const registers = a.emitted.filter((e) => e.event === 'media:register');
    const announces = a.emitted.filter((e) => e.event === 'media:announce');
    expect(registers).toEqual([{ event: 'media:register', payload: { endpointId: id } }]);
    expect(announces).toHaveLength(1);

    const registerAt = a.emitted.findIndex((e) => e.event === 'media:register');
    const announceAt = a.emitted.findIndex((e) => e.event === 'media:announce');
    expect(registerAt).toBeGreaterThanOrEqual(0);
    expect(registerAt).toBeLessThan(announceAt);
  });
});
