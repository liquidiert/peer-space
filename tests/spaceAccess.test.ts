import { describe, expect, it } from 'vitest';
import { canEnterSpace, normalizeEmails, spacesFor } from '../src/lib/spaceAccess';
import type { Space } from '../src/types';

const space = (id: string, over: Partial<Space> = {}): Space => ({
  id,
  name: id,
  activeMapId: `${id}:map`,
  memberEmails: [],
  openToAll: false,
  ...over,
});

describe('normalizeEmails', () => {
  it('trims, lower-cases, de-duplicates and drops junk', () => {
    expect(normalizeEmails([' A@x.com ', 'a@X.com', '', 3, null, 'b@x.com'])).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });

  it('returns an empty list for non-arrays', () => {
    expect(normalizeEmails('a@x.com')).toEqual([]);
  });
});

describe('canEnterSpace', () => {
  it('lets admins into any space', () => {
    expect(canEnterSpace(space('a'), { isAdmin: true })).toBe(true);
  });

  it('lets assigned members in, ignoring email case', () => {
    const s = space('a', { memberEmails: ['a@x.com'] });
    expect(canEnterSpace(s, { email: 'A@X.com', isAdmin: false })).toBe(true);
    expect(canEnterSpace(s, { email: 'b@x.com', isAdmin: false })).toBe(false);
  });

  it('keeps out users without an email unless the space is open', () => {
    expect(canEnterSpace(space('a'), { email: '', isAdmin: false })).toBe(false);
    expect(canEnterSpace(space('a', { openToAll: true }), { isAdmin: false })).toBe(true);
  });
});

describe('spacesFor', () => {
  it('returns only enterable spaces, sorted by name', () => {
    const all = [
      space('b', { memberEmails: ['u@x.com'] }),
      space('c'),
      space('a', { memberEmails: ['u@x.com'] }),
    ];
    expect(spacesFor(all, { email: 'u@x.com', isAdmin: false }).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
