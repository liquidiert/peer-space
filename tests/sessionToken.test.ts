import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session token is the only thing standing between a client and admin privileges - the
 * socket layer derives isAdmin from it and refuses to trust a client-supplied boolean. It
 * had no tests, which is how "admin stopped working" turned out to be "the token silently
 * stopped verifying" rather than anything wrong with the admin check itself.
 *
 * SESSION_SECRET is read at module load, so each case imports the module fresh.
 */
async function loadSession(secret = 'test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  vi.resetModules();
  process.env.SESSION_SECRET = secret;
  return import('../src/lib/session');
}

const payload = { email: 'admin@example.com', name: 'Ada', isAdmin: true };

describe('session tokens', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a verified login, admin flag included', async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const verified = verifySessionToken(createSessionToken(payload));

    expect(verified).not.toBeNull();
    expect(verified!.isAdmin).toBe(true);
    expect(verified!.email).toBe('admin@example.com');
    expect(verified!.name).toBe('Ada');
  });

  it('rejects a token signed with a different secret', async () => {
    // This is the restart case: with SESSION_SECRET unset the server generates a random one
    // per boot, so every token issued before a restart looks forged afterwards.
    const first = await loadSession('secret-number-one-aaaaaaaaaaaaaaaaaa');
    const token = first.createSessionToken(payload);

    const second = await loadSession('secret-number-two-bbbbbbbbbbbbbbbbbb');
    expect(second.verifySessionToken(token)).toBeNull();
  });

  it('rejects a token past its TTL', async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const token = createSessionToken(payload, 1000);

    expect(verifySessionToken(token)).not.toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    expect(verifySessionToken(token)).toBeNull();
  });

  it('rejects a tampered payload, including a self-promoted isAdmin', async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const token = createSessionToken({ ...payload, isAdmin: false });
    const [encoded, signature] = token.split('.');

    const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    body.isAdmin = true;
    const forged = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${signature}`;

    expect(verifySessionToken(forged)).toBeNull();
  });

  it('rejects malformed input rather than throwing', async () => {
    const { verifySessionToken } = await loadSession();
    // A signature of a different length must not blow up timingSafeEqual.
    for (const bad of [undefined, null, '', 'no-dot', 'a.b', 'a.', '.b', 42, {}]) {
      expect(verifySessionToken(bad)).toBeNull();
    }
  });
});
