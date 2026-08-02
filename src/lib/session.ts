import crypto from 'crypto';

// Signs a compact, server-issued session token after a Keycloak login has been verified
// once in the OAuth callback. The socket layer then trusts this token (not raw client input)
// for identity/isAdmin, since socket.io connections have no built-in auth of their own.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[session] SESSION_SECRET is not set - using a random secret generated for this process. ' +
      'Every restart/redeploy will invalidate existing sessions. Set SESSION_SECRET in production.'
  );
}

export interface SessionPayload {
  email: string;
  name: string;
  isAdmin: boolean;
  exp: number;
}

function sign(data: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

export function createSessionToken(
  payload: Omit<SessionPayload, 'exp'>,
  ttlMs = 12 * 60 * 60 * 1000
): string {
  const body: SessionPayload = { ...payload, exp: Date.now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifySessionToken(token: unknown): SessionPayload | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expectedSignature = sign(encoded);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const body: SessionPayload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    if (typeof body.exp !== 'number' || body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}
