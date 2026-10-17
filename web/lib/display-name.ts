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
