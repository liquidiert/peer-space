import { describe, expect, it } from 'vitest';
import { canClaimDesk, canManageDesk, isDeskEquipment, ownsDesk } from '../src/lib/deskPermissions';
import type { DeskState } from '../src/types';

const sam = { id: 'sam@example.com' };
const alex = { id: 'alex@example.com' };
const admin = { id: 'root@example.com', isAdmin: true };

const unclaimed: DeskState = {};
const samsDesk: DeskState = { claimedByUserId: sam.id, claimedByUserName: 'Sam' };

describe('claiming a desk', () => {
  it('allows anyone to take a free desk', () => {
    expect(canClaimDesk(alex, unclaimed)).toBe(true);
    expect(canClaimDesk(alex, undefined)).toBe(true);
  });

  it("refuses a desk someone else already holds", () => {
    expect(canClaimDesk(alex, samsDesk)).toBe(false);
  });

  it('treats re-claiming your own desk as allowed rather than an error', () => {
    expect(canClaimDesk(sam, samsDesk)).toBe(true);
  });

  it('refuses an actor with no id', () => {
    expect(canClaimDesk({ id: '' }, unclaimed)).toBe(false);
    expect(canClaimDesk(null, unclaimed)).toBe(false);
  });
});

describe('managing a desk (release, status, equipment)', () => {
  it('allows the holder', () => {
    expect(canManageDesk(sam, samsDesk)).toBe(true);
  });

  it('refuses everyone else', () => {
    // This is the hole being closed: previously any client could rewrite any desk, including
    // unclaiming someone else's or reassigning it to themselves.
    expect(canManageDesk(alex, samsDesk)).toBe(false);
  });

  it('allows an admin, so an abandoned desk can be freed', () => {
    expect(canManageDesk(admin, samsDesk)).toBe(true);
  });

  it('grants nothing on an unclaimed desk except to an admin', () => {
    expect(canManageDesk(alex, unclaimed)).toBe(false);
    expect(canManageDesk(admin, unclaimed)).toBe(true);
  });

  it('does not authorise on the display name', () => {
    // Someone renaming themselves to "Sam" must not inherit control of Sam's desk.
    const impostor = { id: 'mallory@example.com' };
    expect(canManageDesk(impostor, samsDesk)).toBe(false);
  });

  it('does not match a blank id against a desk with no claimant', () => {
    expect(ownsDesk({ id: '' }, unclaimed)).toBe(false);
    expect(ownsDesk({ id: '' }, { claimedByUserId: '' })).toBe(false);
  });
});

describe('equipment validation', () => {
  it('accepts only the known kinds', () => {
    expect(isDeskEquipment('laptop')).toBe(true);
    expect(isDeskEquipment('gaming_rig')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'nonsense', '<script>', null, undefined, 42, {}]) {
      expect(isDeskEquipment(bad)).toBe(false);
    }
  });
});
