/**
 * Display name for a user-shaped API value, mirroring `mobile/utils/display-name.ts`.
 *
 * A deleted account is a tombstone: the API keeps the row with `deletedAt` set
 * and the name replaced by an English literal. Render our own label from
 * `deletedAt` and never branch on the stored name (#814).
 */
import { STRINGS } from './strings';

export interface NamedUser {
  name: string;
  /** ISO timestamp when the account was deleted; null/absent for live accounts. */
  deletedAt?: string | null;
}

export function displayName(user: NamedUser | null | undefined): string {
  if (!user) return '';
  return user.deletedAt ? STRINGS.deletedUser : user.name;
}

/*
 * Flattened payloads carry a name string beside its tombstone timestamp
 * (`inviterName` / `inviterDeletedAt`, `childName` / `childDeletedAt`, #813).
 * These read them through `displayName`, mirroring the mobile helpers.
 */

export function inviterDisplayName(x: { inviterName: string; inviterDeletedAt?: string | null }): string {
  return displayName({ name: x.inviterName, deletedAt: x.inviterDeletedAt });
}

export function childDisplayName(x: { childName: string; childDeletedAt?: string | null }): string {
  return displayName({ name: x.childName, deletedAt: x.childDeletedAt });
}
