import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canRevoke,
  isAdminEmail,
  listAdmins,
  normalizeAdminEmail,
  parseAdminEmails,
} from '../src/lib/admins';
import type { SQLiteDriver } from '../src/db';

describe('normalizeAdminEmail', () => {
  it('trims and lower-cases a valid email', () => {
    expect(normalizeAdminEmail('  Admin@Example.COM ')).toBe('admin@example.com');
  });

  it('rejects empty, non-string and malformed values', () => {
    expect(normalizeAdminEmail('')).toBeNull();
    expect(normalizeAdminEmail('   ')).toBeNull();
    expect(normalizeAdminEmail(undefined)).toBeNull();
    expect(normalizeAdminEmail(42)).toBeNull();
    expect(normalizeAdminEmail('no-at-sign.com')).toBeNull();
    expect(normalizeAdminEmail('a@nodot')).toBeNull();
    expect(normalizeAdminEmail('a b@x.com')).toBeNull();
  });
});

describe('parseAdminEmails', () => {
  it('handles whitespace, case, duplicates and empty entries', () => {
    const parsed = parseAdminEmails(' A@x.com , a@X.com,,  b@x.com ,');
    expect([...parsed]).toEqual(['a@x.com', 'b@x.com']);
  });

  it('drops invalid entries but keeps valid ones', () => {
    const parsed = parseAdminEmails('good@x.com, not-an-email, @x.com, c@y.org');
    expect([...parsed]).toEqual(['good@x.com', 'c@y.org']);
  });

  it('returns an empty set for missing or blank input', () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails('').size).toBe(0);
    expect(parseAdminEmails(' , , ').size).toBe(0);
  });
});

describe('isAdminEmail', () => {
  const env = new Set(['env@x.com']);
  const db = new Set(['db@x.com']);

  it('grants admin rights to env admins', () => {
    expect(isAdminEmail('ENV@x.com', env, db)).toBe(true);
  });

  it('grants admin rights to DB admins', () => {
    expect(isAdminEmail(' db@X.com', env, db)).toBe(true);
  });

  it('denies emails in neither set', () => {
    expect(isAdminEmail('nobody@x.com', env, db)).toBe(false);
  });

  it('denies undefined, null and invalid emails', () => {
    expect(isAdminEmail(undefined, env, db)).toBe(false);
    expect(isAdminEmail(null, env, db)).toBe(false);
    expect(isAdminEmail('', env, db)).toBe(false);
    expect(isAdminEmail('not-an-email', env, db)).toBe(false);
  });
});

describe('listAdmins', () => {
  it('sorts by email and tags each source', () => {
    const result = listAdmins(new Set(['zed@x.com']), new Set(['amy@x.com']));
    expect(result).toEqual([
      { email: 'amy@x.com', source: 'db' },
      { email: 'zed@x.com', source: 'env' },
    ]);
  });

  it('lists an email in both sets once, as env', () => {
    const result = listAdmins(new Set(['both@x.com']), new Set(['both@x.com', 'db@x.com']));
    expect(result).toEqual([
      { email: 'both@x.com', source: 'env' },
      { email: 'db@x.com', source: 'db' },
    ]);
  });

  it('returns an empty list when there are no admins', () => {
    expect(listAdmins(new Set(), new Set())).toEqual([]);
  });
});

describe('canRevoke', () => {
  const env = new Set(['env@x.com']);

  it('allows revoking a DB admin', () => {
    expect(canRevoke('db@x.com', env)).toEqual({ ok: true });
  });

  it('refuses to revoke an env admin, regardless of case', () => {
    const result = canRevoke(' ENV@x.com ', env);
    expect(result.ok).toBe(false);
  });

  it('refuses an invalid target', () => {
    expect(canRevoke('', env).ok).toBe(false);
  });
});

describe('admins table round-trip', () => {
  const originalDataDir = process.env.DATA_DIR;
  let dataDir: string;
  let driver: SQLiteDriver;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admins-test-'));
    process.env.DATA_DIR = dataDir;
    // db.ts reads DATA_DIR at module load, so it must be imported after the env is set.
    const { initWorkspaceDatabase } = await import('../src/db');
    driver = await initWorkspaceDatabase();
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts empty', () => {
    expect(driver.listDbAdmins().filter((a) => a.email.startsWith('rt-'))).toEqual([]);
  });

  it('adds, lists and removes admins', () => {
    driver.addDbAdmin('rt-one@x.com', 'granter@x.com');
    const listed = driver.listDbAdmins().find((a) => a.email === 'rt-one@x.com');
    expect(listed).toBeDefined();
    expect(listed!.grantedBy).toBe('granter@x.com');
    expect(typeof listed!.grantedAt).toBe('number');

    expect(driver.removeDbAdmin('rt-one@x.com')).toBe(true);
    expect(driver.listDbAdmins().some((a) => a.email === 'rt-one@x.com')).toBe(false);
  });

  it('returns false when removing an email that is not an admin', () => {
    expect(driver.removeDbAdmin('rt-missing@x.com')).toBe(false);
  });

  it('keeps the original grant when adding an existing admin again', () => {
    driver.addDbAdmin('rt-two@x.com', 'first@x.com');
    const before = driver.listDbAdmins().find((a) => a.email === 'rt-two@x.com')!;

    driver.addDbAdmin('rt-two@x.com', 'second@x.com');
    const after = driver.listDbAdmins().filter((a) => a.email === 'rt-two@x.com');

    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
    expect(after[0].grantedBy).toBe('first@x.com');
  });
});
