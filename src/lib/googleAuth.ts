/**
 * Google OpenID Connect sign-in: authorization code flow with PKCE, plus the sealed login-state
 * cookie that carries state, verifier and nonce from the login redirect to the callback.
 *
 * Pure logic only: no request or response objects, no environment reads. server.ts owns the
 * routes and cookies and calls into this module, so the parts that decide who is signed in can
 * be tested directly. Uses Node `crypto` and the global `fetch` only.
 */
import crypto from 'crypto';

/** Google's authorization endpoint (OAuth 2.0 / OIDC, v2). */
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google's token endpoint, used server-side to exchange the authorization code. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Accepted `iss` values in an id_token. Google issues both spellings; anything else is rejected.
 */
export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/** Label that domain-separates the login-state encryption key from any other use of the secret. */
const LOGIN_STATE_LABEL = 'peerspace-login-state';

/** AES-256-GCM parameters for the sealed login state. */
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Contents of the login-state cookie, written at login and read back at the callback. */
export interface LoginStatePayload {
  /** Random `state` sent to Google; must match the `state` query param on the callback. */
  state: string;
  /** PKCE code verifier; its challenge was sent in the authorization request. */
  verifier: string;
  /** Random `nonce` sent to Google; must match the id_token's `nonce` claim. */
  nonce: string;
  /** When the login started, in epoch milliseconds. */
  createdAt: number;
}

/** Claims the sign-in cares about after validation. */
export interface GoogleIdentity {
  email: string;
  name: string;
  sub: string;
}

/**
 * Generates a PKCE pair (RFC 7636). The verifier is 32 random bytes, base64url-encoded (43
 * characters). The challenge is base64url(SHA-256(verifier)), sent with method S256.
 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Random URL-safe token for the OAuth `state` and `nonce` values. `bytes` random bytes,
 * base64url-encoded without padding.
 */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Builds the Google authorization URL for the redirect that starts sign-in. Always requests
 * `openid email profile`, asks for account selection on each login (`prompt=select_account`),
 * and uses an online-only access type since no refresh token is kept.
 */
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    access_type: 'online',
  }).toString();
  return url.toString();
}

/**
 * Derives the AES-256 key for the login-state cookie from the server secret with HKDF-SHA256.
 * The fixed label keeps this key separate from anything else derived from the same secret.
 */
function loginStateKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', secret, Buffer.alloc(0), LOGIN_STATE_LABEL, 32)
  );
}

/**
 * Encrypts the login state into an opaque cookie value using AES-256-GCM with a random 12-byte
 * IV. The browser can neither read the verifier and nonce nor forge or alter them. Output is
 * base64url(iv | ciphertext | tag). Throws if `secret` is empty, since that is a
 * configuration error rather than bad input.
 */
export function sealLoginState(payload: LoginStatePayload, secret: string): string {
  if (!secret) throw new Error('sealLoginState requires a non-empty secret');
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', loginStateKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64url');
}

/**
 * Decrypts and checks a sealed login state. Returns the payload, or null for anything wrong:
 * not a string, too short, failed authentication (tampered or wrong secret), bad JSON or shape,
 * or older than `maxAgeMs` relative to `now`. Never throws.
 */
export function openLoginState(
  sealed: unknown,
  secret: string,
  now = Date.now(),
  maxAgeMs = 10 * 60_000
): LoginStatePayload | null {
  try {
    if (typeof sealed !== 'string' || !secret) return null;
    const bytes = Buffer.from(sealed, 'base64url');
    if (bytes.length <= GCM_IV_BYTES + GCM_TAG_BYTES) return null;

    const iv = bytes.subarray(0, GCM_IV_BYTES);
    const ciphertext = bytes.subarray(GCM_IV_BYTES, bytes.length - GCM_TAG_BYTES);
    const tag = bytes.subarray(bytes.length - GCM_TAG_BYTES);

    const decipher = crypto.createDecipheriv('aes-256-gcm', loginStateKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const body: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!isRecord(body)) return null;
    const { state, verifier, nonce, createdAt } = body;
    if (
      typeof state !== 'string' ||
      typeof verifier !== 'string' ||
      typeof nonce !== 'string' ||
      typeof createdAt !== 'number' ||
      !Number.isFinite(createdAt)
    ) {
      return null;
    }
    if (now - createdAt > maxAgeMs) return null;

    return { state, verifier, nonce, createdAt };
  } catch {
    return null;
  }
}

/**
 * Exchanges the authorization code for tokens at Google's token endpoint and returns the
 * id_token. The request is form-encoded and carries the PKCE verifier and the client secret.
 *
 * Throws on a non-ok response or a missing id_token. The error includes the HTTP status but
 * never the client secret or Google's response body, so it is safe to log.
 */
export async function exchangeCode(params: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ idToken: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.verifier,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed with status ${res.status}`);
  }

  const json: unknown = await res.json();
  const idToken = isRecord(json) ? json.id_token : undefined;
  if (typeof idToken !== 'string' || !idToken) {
    throw new Error('Google token response did not include an id_token');
  }
  return { idToken };
}

/**
 * Reads the payload (middle segment) of a JWT without verifying it. Returns null for anything
 * that is not three dot-separated base64url segments whose payload is a JSON object.
 */
export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const segment = parts[1];
    if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;

    const json: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Checks decoded id_token claims and returns the signed-in identity, or `{ error }` naming the
 * first check that failed.
 *
 * The id_token is obtained directly from Google's token endpoint over TLS by the server, so per
 * OIDC Core 3.1.3.7 the TLS server validation stands in for signature verification. Claims are
 * still checked: issuer, audience (and `azp` when there are several audiences), expiry, `iat`
 * not in the future, nonce, and a verified email.
 *
 * `exp` and `iat` are seconds since the epoch; `now` and `skewMs` are milliseconds.
 */
export function validateIdTokenClaims(
  claims: Record<string, unknown>,
  options: { clientId: string; nonce: string; now?: number; skewMs?: number }
): GoogleIdentity | { error: string } {
  const now = options.now ?? Date.now();
  const skewMs = options.skewMs ?? 60_000;

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
    return { error: 'unexpected issuer' };
  }

  const { aud, azp } = claims;
  if (Array.isArray(aud)) {
    if (!aud.includes(options.clientId)) return { error: 'audience does not include this client' };
    if (azp !== options.clientId) return { error: 'authorized party is not this client' };
  } else if (aud !== options.clientId) {
    return { error: 'audience does not match this client' };
  }

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { error: 'missing expiry' };
  }
  if (claims.exp * 1000 <= now - skewMs) return { error: 'id_token expired' };

  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
      return { error: 'invalid issued-at' };
    }
    if (claims.iat * 1000 > now + skewMs) return { error: 'id_token issued in the future' };
  }

  if (claims.nonce !== options.nonce) return { error: 'nonce mismatch' };
  if (claims.email_verified !== true) return { error: 'email is not verified' };

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) return { error: 'missing email' };

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) return { error: 'missing subject' };

  return { email, name: displayName(claims, email), sub };
}

/**
 * Display name for a verified identity: the `name` claim if present, else `given_name` and
 * `family_name` joined, else the email's local part with `.`, `_` and `-` turned into spaces and
 * each word title-cased. If that leaves nothing, the email itself is used.
 */
function displayName(claims: Record<string, unknown>, email: string): string {
  if (typeof claims.name === 'string' && claims.name.trim()) return claims.name.trim();

  const given = typeof claims.given_name === 'string' ? claims.given_name.trim() : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name.trim() : '';
  const joined = [given, family].filter(Boolean).join(' ');
  if (joined) return joined;

  const local = email.split('@')[0] ?? '';
  const words = local
    .replace(/[._-]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return words.length > 0 ? words.join(' ') : email;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
