import type { DeskState, StickyNote } from '../types';

/**
 * Who may delete a sticky note.
 *
 * Shared so the button the modal offers and the rule the server enforces are literally the
 * same function - the client half decides what to *show*, the server half is the authority.
 * If they drifted apart you would get buttons that silently do nothing, or worse, a UI that
 * hides an action the server would actually have allowed.
 */

export interface NoteActor {
  /** Stable user id (verified email when signed in, else the persisted browser id). */
  id: string;
  isAdmin?: boolean;
}

export function canDeleteNote(
  actor: NoteActor | null | undefined,
  note: StickyNote | null | undefined,
  deskState?: DeskState | null
): boolean {
  if (!actor || !note) return false;

  // Admins can clear anything, including notes too old to be attributed.
  if (actor.isAdmin) return true;

  // Authorship is checked against authorId, never `author`. A display name is chosen by the
  // user and is neither unique nor verified, so matching on it would let two people with the
  // same name delete each other's notes - or let anyone impersonate by renaming themselves.
  // Notes written before authorId existed have none, and stay admin-only.
  if (note.authorId && actor.id && note.authorId === actor.id) return true;

  // Whoever a desk belongs to can also clear notes other people left on it.
  if (deskState?.claimedByUserId && actor.id && deskState.claimedByUserId === actor.id) return true;

  return false;
}
