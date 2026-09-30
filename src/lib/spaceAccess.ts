import type { Space } from '../types';

export interface SpaceViewer {
  email?: string;
  isAdmin: boolean;
}

/** Trims, lower-cases and de-duplicates; drops anything that is not a string or is empty. */
export function normalizeEmails(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const email = value.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

/**
 * Admins may enter every space, otherwise it takes a verified email that has been assigned to
 * the space (or the space being open to all). Emails are compared case-insensitively.
 */
export function canEnterSpace(space: Space, viewer: SpaceViewer): boolean {
  if (viewer.isAdmin) return true;
  if (space.openToAll) return true;
  const email = viewer.email?.trim().toLowerCase();
  return !!email && space.memberEmails.includes(email);
}

export function spacesFor(spaces: Iterable<Space>, viewer: SpaceViewer): Space[] {
  return [...spaces]
    .filter((space) => canEnterSpace(space, viewer))
    .sort((a, b) => a.name.localeCompare(b.name));
}
