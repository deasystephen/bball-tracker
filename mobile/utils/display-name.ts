/**
 * Display name for a user-shaped API object (#444, account deletion).
 *
 * A deleted account is a tombstone: the API keeps the row (so stats stay
 * coherent) with `deletedAt` set and `name` replaced by an English literal.
 * Clients must render their OWN localized label from `deletedAt` and never
 * branch on the name — same never-inline rule as `utils/game-result.ts`.
 * Payloads without `deletedAt` (older API builds, box-score name strings)
 * fall back to the stored name, which is the same literal in English.
 */
import { i18n } from '../i18n';

export interface NamedUser {
  name: string;
  /** ISO timestamp when the account was deleted; null/absent for live accounts. */
  deletedAt?: string | null;
}

export function isDeletedUser(user: NamedUser | null | undefined): boolean {
  return Boolean(user?.deletedAt);
}

export function displayName(user: NamedUser | null | undefined): string {
  if (!user) return '';
  return isDeletedUser(user) ? i18n.t('account.deletedUser') : user.name;
}
