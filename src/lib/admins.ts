import { normalizeEmails } from './spaceAccess';

// spaceAccess only requires a non-empty string, which is too loose for admin grants, so an admin
// email additionally needs one "@" and a dotted domain. Kept pure (no DB import) so it is testable.
const ADMIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AdminSource = 'env' | 'db';

/**
 * Normalizes a single email the same way as spaceAccess (trim, lower-case). Returns null when the
 * input is not a string, is empty, or does not look like an email address.
 */
export function normalizeAdminEmail(email: unknown): string | null {
  const [normalized] = normalizeEmails([email]);
  if (!normalized || !ADMIN_EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

/**
 * Parses the comma-separated ADMIN_EMAILS value into a set of normalized emails. Whitespace,
 * case and duplicates are resolved; empty and invalid entries are dropped.
 */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  const admins = new Set<string>();
  if (!raw) return admins;
  for (const part of raw.split(',')) {
    const email = normalizeAdminEmail(part);
    if (email) admins.add(email);
  }
  return admins;
}

/**
 * True when the email is an admin through either source. Both sets are expected to hold normalized
 * emails (as produced by parseAdminEmails and the DB layer); the input email is normalized here.
 * An undefined, null or invalid email is never an admin.
 */
export function isAdminEmail(
  email: string | undefined | null,
  envAdmins: Set<string>,
  dbAdmins: Set<string>
): boolean {
  const normalized = normalizeAdminEmail(email);
  if (!normalized) return false;
  return envAdmins.has(normalized) || dbAdmins.has(normalized);
}

/**
 * Lists every admin once, sorted by email. An email present in both sources is reported as 'env',
 * since env admins cannot be revoked in the app and that is the more authoritative source.
 */
export function listAdmins(
  envAdmins: Set<string>,
  dbAdmins: Set<string>
): { email: string; source: AdminSource }[] {
  const sources = new Map<string, AdminSource>();
  for (const email of dbAdmins) sources.set(email, 'db');
  for (const email of envAdmins) sources.set(email, 'env');
  return [...sources]
    .map(([email, source]) => ({ email, source }))
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}

/**
 * Decides whether the target admin may be revoked in the app. Env admins can never be revoked
 * (they are controlled by the ADMIN_EMAILS configuration), so the caller must not remove them from
 * the DB table either. The target is normalized before the check.
 */
export function canRevoke(
  target: string,
  envAdmins: Set<string>
): { ok: true } | { ok: false; reason: string } {
  const email = normalizeAdminEmail(target);
  if (!email) return { ok: false, reason: 'Not a valid email address.' };
  if (envAdmins.has(email)) {
    return { ok: false, reason: 'Admins from ADMIN_EMAILS cannot be revoked in the app.' };
  }
  return { ok: true };
}
