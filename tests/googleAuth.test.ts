import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  createPkce,
  decodeJwtPayload,
  exchangeCode,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  openLoginState,
  randomToken,
  sealLoginState,
  validateIdTokenClaims,
} from '../src/lib/googleAuth';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SECRET = 'test-login-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const NONCE = 'nonce-abc';
const NOW = 1_800_000_000_000;

/** A claims object that passes every check at NOW. Tests override single fields. */
function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '1234567890',
    exp: NOW / 1000 + 300,
    iat: NOW / 1000 - 10,
    nonce: NONCE,
    email: 'Ada.Lovelace@Example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    ...overrides,
  };
}

function validate(claims: Record<string, unknown>) {
  return validateIdTokenClaims(claims, { clientId: CLIENT_ID, nonce: NONCE, now: NOW });
}

function errorOf(result: ReturnType<typeof validate>): string | undefined {
  return 'error' in result ? result.error : undefined;
}

describe('createPkce', () => {
  it('returns a base64url verifier and challenge without padding', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(BASE64URL);
    expect(challenge).toMatch(BASE64URL);
    expect(verifier).toHaveLength(43); // 32 bytes, base64url without padding
  });

  it('sets the challenge to base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkce();
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('gives a fresh verifier on each call', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

describe('randomToken', () => {
  it('is base64url and defaults to 32 bytes', () => {
    const token = randomToken();
    expect(token).toMatch(BASE64URL);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('honours the byte count', () => {
    expect(Buffer.from(randomToken(16), 'base64url')).toHaveLength(16);
  });
});

describe('buildAuthUrl', () => {
  it('points at the Google authorization endpoint with every required param', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: CLIENT_ID,
        redirectUri: 'https://app.example.com/auth/google/callback',
        state: 'state-1',
        nonce: NONCE,
        codeChallenge: 'challenge-1',
      })
    );

    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: 'https://app.example.com/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      state: 'state-1',
      nonce: NONCE,
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      prompt: 'select_account',
      access_type: 'online',
    });
  });
});

describe('sealLoginState / openLoginState', () => {
  const payload = { state: 's', verifier: 'v', nonce: 'n', createdAt: NOW };

  it('round-trips the payload', () => {
    const sealed = sealLoginState(payload, SECRET);
    expect(sealed).toMatch(BASE64URL);
    expect(openLoginState(sealed, SECRET, NOW)).toEqual(payload);
  });

  it('does not expose the verifier or nonce in the sealed value', () => {
    const sealed = sealLoginState({ ...payload, verifier: 'plainverifier' }, SECRET);
    expect(sealed).not.toContain('plainverifier');
    expect(Buffer.from(sealed, 'base64url').toString('utf8')).not.toContain('plainverifier');
  });

  it('returns null when a ciphertext byte is tampered with', () => {
    const bytes = Buffer.from(sealLoginState(payload, SECRET), 'base64url');
    bytes[14] ^= 0xff; // inside the ciphertext, after the 12-byte IV
    expect(openLoginState(bytes.toString('base64url'), SECRET, NOW)).toBeNull();
  });

  it('returns null when the tag is tampered with', () => {
    const bytes = Buffer.from(sealLoginState(payload, SECRET), 'base64url');
    bytes[bytes.length - 1] ^= 0x01;
    expect(openLoginState(bytes.toString('base64url'), SECRET, NOW)).toBeNull();
  });

  it('returns null for a wrong secret', () => {
    const sealed = sealLoginState(payload, SECRET);
    expect(openLoginState(sealed, 'some-other-secret', NOW)).toBeNull();
  });

  it('returns null once the state is older than maxAgeMs', () => {
    const sealed = sealLoginState(payload, SECRET);
    expect(openLoginState(sealed, SECRET, NOW + 10 * 60_000)).not.toBeNull();
    expect(openLoginState(sealed, SECRET, NOW + 10 * 60_000 + 1)).toBeNull();
    expect(openLoginState(sealed, SECRET, NOW + 60_000, 30_000)).toBeNull();
  });

  it('returns null for garbage input without throwing', () => {
    expect(openLoginState('', SECRET, NOW)).toBeNull();
    expect(openLoginState('not-a-real-cookie', SECRET, NOW)).toBeNull();
    expect(openLoginState('%%%%', SECRET, NOW)).toBeNull();
    expect(openLoginState(undefined, SECRET, NOW)).toBeNull();
    expect(openLoginState(12345, SECRET, NOW)).toBeNull();
    expect(openLoginState(randomToken(64), SECRET, NOW)).toBeNull();
  });

  it('returns null for a validly sealed value whose plaintext has the wrong shape', () => {
    // Seal a body that is valid JSON but not a login state, using the same key derivation.
    const key = Buffer.from(
      crypto.hkdfSync('sha256', SECRET, Buffer.alloc(0), 'peerspace-login-state', 32)
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify({ state: 's' })), cipher.final()]);
    const sealed = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
    expect(openLoginState(sealed, SECRET, NOW)).toBeNull();
  });

  it('throws when sealing with an empty secret', () => {
    expect(() => sealLoginState(payload, '')).toThrow();
  });
});

describe('exchangeCode', () => {
  const params = {
    code: 'auth-code-xyz',
    verifier: 'verifier-123',
    clientId: CLIENT_ID,
    clientSecret: 'super-secret-client-value',
    redirectUri: 'https://app.example.com/auth/google/callback',
  };

  it('POSTs a form-encoded body with every field', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id_token: 'a.b.c' }), { status: 200 })
    );

    const result = await exchangeCode({ ...params, fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({ idToken: 'a.b.c' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code-xyz',
      code_verifier: 'verifier-123',
      client_id: CLIENT_ID,
      client_secret: 'super-secret-client-value',
      redirect_uri: 'https://app.example.com/auth/google/callback',
    });
  });

  it('throws on a non-ok response without leaking the client secret', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );

    const attempt = exchangeCode({ ...params, fetchImpl: fetchImpl as typeof fetch });
    await expect(attempt).rejects.toThrow(/400/);
    await expect(attempt).rejects.not.toThrow(params.clientSecret);
  });

  it('throws when the response has no id_token', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'x' }), { status: 200 })
    );
    await expect(
      exchangeCode({ ...params, fetchImpl: fetchImpl as typeof fetch })
    ).rejects.toThrow(/id_token/);
  });
});

describe('decodeJwtPayload', () => {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

  it('reads the middle segment as a JSON object', () => {
    const token = `${encode({ alg: 'RS256' })}.${encode({ sub: '42' })}.sig`;
    expect(decodeJwtPayload(token)).toEqual({ sub: '42' });
  });

  it('returns null for malformed input', () => {
    expect(decodeJwtPayload(undefined)).toBeNull();
    expect(decodeJwtPayload(42)).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('only-one-segment')).toBeNull();
    expect(decodeJwtPayload('a.b')).toBeNull();
    expect(decodeJwtPayload('a.b.c.d')).toBeNull();
    expect(decodeJwtPayload('a..c')).toBeNull();
    expect(decodeJwtPayload('a.not+base64/!.c')).toBeNull();
    expect(decodeJwtPayload(`a.${Buffer.from('not json').toString('base64url')}.c`)).toBeNull();
    expect(decodeJwtPayload(`a.${encode([1, 2])}.c`)).toBeNull();
    expect(decodeJwtPayload(`a.${encode('string')}.c`)).toBeNull();
    expect(decodeJwtPayload(`a.${encode(null)}.c`)).toBeNull();
  });
});

describe('validateIdTokenClaims', () => {
  it('accepts a valid token and returns the identity', () => {
    expect(validate(validClaims())).toEqual({
      email: 'ada.lovelace@example.com',
      name: 'Ada Lovelace',
      sub: '1234567890',
    });
  });

  it('accepts the bare-host issuer', () => {
    expect(errorOf(validate(validClaims({ iss: 'accounts.google.com' })))).toBeUndefined();
  });

  it('rejects an unexpected issuer', () => {
    expect(errorOf(validate(validClaims({ iss: 'https://evil.example.com' })))).toBe(
      'unexpected issuer'
    );
    expect(errorOf(validate(validClaims({ iss: undefined })))).toBe('unexpected issuer');
  });

  it('rejects a string audience for a different client', () => {
    expect(errorOf(validate(validClaims({ aud: 'other-client' })))).toBe(
      'audience does not match this client'
    );
  });

  it('accepts an audience array that includes this client with azp set to it', () => {
    const claims = validClaims({ aud: [CLIENT_ID, 'other-client'], azp: CLIENT_ID });
    expect(errorOf(validate(claims))).toBeUndefined();
  });

  it('rejects an audience array without this client', () => {
    const claims = validClaims({ aud: ['other-client'], azp: 'other-client' });
    expect(errorOf(validate(claims))).toBe('audience does not include this client');
  });

  it('rejects an audience array that includes this client but has no azp', () => {
    const claims = validClaims({ aud: [CLIENT_ID, 'other-client'], azp: undefined });
    expect(errorOf(validate(claims))).toBe('authorized party is not this client');
  });

  it('rejects an audience array whose azp is a different client', () => {
    const claims = validClaims({ aud: [CLIENT_ID, 'other-client'], azp: 'other-client' });
    expect(errorOf(validate(claims))).toBe('authorized party is not this client');
  });

  it('rejects an expired token', () => {
    expect(errorOf(validate(validClaims({ exp: NOW / 1000 - 120 })))).toBe('id_token expired');
  });

  it('allows expiry within the clock skew', () => {
    expect(errorOf(validate(validClaims({ exp: NOW / 1000 - 30 })))).toBeUndefined();
  });

  it('rejects a token with no numeric expiry', () => {
    expect(errorOf(validate(validClaims({ exp: undefined })))).toBe('missing expiry');
  });

  it('rejects an iat in the future beyond the skew', () => {
    expect(errorOf(validate(validClaims({ iat: NOW / 1000 + 300 })))).toBe(
      'id_token issued in the future'
    );
  });

  it('allows an iat slightly ahead within the skew, and a missing iat', () => {
    expect(errorOf(validate(validClaims({ iat: NOW / 1000 + 30 })))).toBeUndefined();
    expect(errorOf(validate(validClaims({ iat: undefined })))).toBeUndefined();
  });

  it('rejects a nonce mismatch', () => {
    expect(errorOf(validate(validClaims({ nonce: 'other-nonce' })))).toBe('nonce mismatch');
    expect(errorOf(validate(validClaims({ nonce: undefined })))).toBe('nonce mismatch');
  });

  it('rejects email_verified that is false', () => {
    expect(errorOf(validate(validClaims({ email_verified: false })))).toBe(
      'email is not verified'
    );
  });

  it('rejects email_verified given as the string "true"', () => {
    expect(errorOf(validate(validClaims({ email_verified: 'true' })))).toBe(
      'email is not verified'
    );
  });

  it('rejects a missing or blank email', () => {
    expect(errorOf(validate(validClaims({ email: undefined })))).toBe('missing email');
    expect(errorOf(validate(validClaims({ email: '   ' })))).toBe('missing email');
  });

  it('rejects a missing sub', () => {
    expect(errorOf(validate(validClaims({ sub: undefined })))).toBe('missing subject');
    expect(errorOf(validate(validClaims({ sub: '' })))).toBe('missing subject');
  });

  it('lowercases and trims the email', () => {
    const result = validate(validClaims({ email: '  Mixed.Case@Example.COM ' }));
    expect(result).toMatchObject({ email: 'mixed.case@example.com' });
  });

  describe('name fallbacks', () => {
    it('uses the name claim when present', () => {
      expect(validate(validClaims({ name: ' Grace Hopper ' }))).toMatchObject({
        name: 'Grace Hopper',
      });
    });

    it('joins given_name and family_name when name is absent', () => {
      const claims = validClaims({ name: undefined, given_name: 'Grace', family_name: 'Hopper' });
      expect(validate(claims)).toMatchObject({ name: 'Grace Hopper' });
    });

    it('uses only the given_name when there is no family_name', () => {
      const claims = validClaims({ name: undefined, given_name: 'Grace' });
      expect(validate(claims)).toMatchObject({ name: 'Grace' });
    });

    it('falls back to the title-cased email local part', () => {
      const claims = validClaims({ name: undefined, email: 'jane_doe-smith.x@example.com' });
      expect(validate(claims)).toMatchObject({ name: 'Jane Doe Smith X' });
    });

    it('falls back to the email when the local part has no letters to show', () => {
      const claims = validClaims({ name: undefined, email: '...@example.com' });
      expect(validate(claims)).toMatchObject({ name: '...@example.com' });
    });
  });
});
