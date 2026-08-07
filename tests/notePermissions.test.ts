import { describe, expect, it } from 'vitest';
import { canDeleteNote } from '../src/lib/notePermissions';
import type { DeskState, StickyNote } from '../src/types';

function note(over: Partial<StickyNote> = {}): StickyNote {
  return {
    id: 'n1',
    author: 'Alex',
    authorId: 'alex@example.com',
    text: 'hello',
    color: '#fef08a',
    createdAt: 0,
    ...over,
  };
}

const alex = { id: 'alex@example.com' };
const sam = { id: 'sam@example.com' };
const admin = { id: 'root@example.com', isAdmin: true };

describe('deleting sticky notes', () => {
  it('lets the author delete their own note', () => {
    expect(canDeleteNote(alex, note())).toBe(true);
  });

  it('does not let someone else delete it', () => {
    expect(canDeleteNote(sam, note())).toBe(false);
  });

  it('lets an admin delete anyone\'s note', () => {
    expect(canDeleteNote(admin, note())).toBe(true);
  });

  it('does not authorise on the display name', () => {
    // Names are user-chosen and unverified. Someone renaming themselves to "Alex", or simply
    // another real Alex, must not inherit delete rights over Alex's notes.
    const impostor = { id: 'mallory@example.com' };
    expect(canDeleteNote(impostor, note({ author: 'Alex' }))).toBe(false);
  });

  it('keeps unattributed legacy notes admin-only', () => {
    // Notes posted before authorId existed cannot be tied to anyone.
    const legacy = note({ authorId: undefined });
    expect(canDeleteNote(alex, legacy)).toBe(false);
    expect(canDeleteNote(sam, legacy)).toBe(false);
    expect(canDeleteNote(admin, legacy)).toBe(true);
  });

  it('does not match an actor with a blank id against a note with none', () => {
    // Both sides falsy must not be treated as "same person".
    expect(canDeleteNote({ id: '' }, note({ authorId: undefined }))).toBe(false);
    expect(canDeleteNote({ id: '' }, note({ authorId: '' }))).toBe(false);
  });
});

describe('notes left on a desk', () => {
  const claimed: DeskState = { claimedByUserId: sam.id, claimedByUserName: 'Sam' };

  it('lets the desk owner clear a note someone else left on it', () => {
    expect(canDeleteNote(sam, note(), claimed)).toBe(true);
  });

  it('still lets the note author remove their own', () => {
    expect(canDeleteNote(alex, note(), claimed)).toBe(true);
  });

  it('lets nobody else touch it', () => {
    const bystander = { id: 'kim@example.com' };
    expect(canDeleteNote(bystander, note(), claimed)).toBe(false);
  });

  it('grants nothing extra on an unclaimed desk', () => {
    const unclaimed: DeskState = {};
    const bystander = { id: 'kim@example.com' };
    expect(canDeleteNote(bystander, note(), unclaimed)).toBe(false);
  });
});

describe('malformed input', () => {
  it('refuses rather than throwing', () => {
    expect(canDeleteNote(null, note())).toBe(false);
    expect(canDeleteNote(undefined, note())).toBe(false);
    expect(canDeleteNote(alex, null)).toBe(false);
    expect(canDeleteNote(alex, undefined)).toBe(false);
  });
});
