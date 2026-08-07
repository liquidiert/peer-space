import type { DeskState } from '../types';
import type { NoteActor } from './notePermissions';

/**
 * Who may do what to a desk.
 *
 * Shared so the buttons the modal offers and the rules the server enforces are the same
 * function. As with notes, the client half only decides what to *show*; the server half is
 * the authority and re-checks every action.
 */

export const DESK_EQUIPMENT = [
  'dual_monitors',
  'laptop',
  'gaming_rig',
  'designer_tablet',
  'keyboard',
] as const;

export type DeskEquipment = (typeof DESK_EQUIPMENT)[number];

export function isDeskEquipment(value: unknown): value is DeskEquipment {
  return typeof value === 'string' && (DESK_EQUIPMENT as readonly string[]).includes(value);
}

/** The desk is claimed by this actor. Ownership is by stable id, never by display name. */
export function ownsDesk(actor: NoteActor | null | undefined, deskState?: DeskState | null): boolean {
  if (!actor?.id || !deskState?.claimedByUserId) return false;
  return deskState.claimedByUserId === actor.id;
}

/** A free desk can be taken; a desk you already hold is a no-op rather than an error. */
export function canClaimDesk(actor: NoteActor | null | undefined, deskState?: DeskState | null): boolean {
  if (!actor?.id) return false;
  return !deskState?.claimedByUserId || ownsDesk(actor, deskState);
}

/**
 * Releasing a desk, renaming it or changing its status/equipment. Restricted to the holder
 * and admins - previously any client could rewrite any desk, including unclaiming someone
 * else's or reassigning it to themselves.
 */
export function canManageDesk(actor: NoteActor | null | undefined, deskState?: DeskState | null): boolean {
  if (!actor) return false;
  if (actor.isAdmin) return true;
  return ownsDesk(actor, deskState);
}
