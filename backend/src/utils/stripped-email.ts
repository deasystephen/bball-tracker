/**
 * The per-row sentinel that replaces an invitation's `invitedEmail` when the
 * address is stripped: guardian invitations on account deletion and the
 * under-13 un-claim (D17), staff invitations on the invitee's decline and on
 * the same two paths (#460). `deleted-<row id>@invalid` keeps the column NOT
 * NULL, cannot collide (ids are unique), and is not deliverable (`.invalid`
 * is reserved, RFC 2606).
 *
 * One definition for the TypeScript writers and the raw-SQL scrub, which
 * builds the same value per row as `${STRIPPED_EMAIL_PREFIX} || "id" ||
 * ${STRIPPED_EMAIL_SUFFIX}`.
 */
export const STRIPPED_EMAIL_PREFIX = 'deleted-';
export const STRIPPED_EMAIL_SUFFIX = '@invalid';

export function strippedEmailFor(rowId: string): string {
  return `${STRIPPED_EMAIL_PREFIX}${rowId}${STRIPPED_EMAIL_SUFFIX}`;
}
