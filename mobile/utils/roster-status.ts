/**
 * Roster invite-status chips (roster/invite unification spec,
 * docs/plans/roster-invite-unification-spec.md).
 *
 * Derivation mirrors the backend rule exactly — never inline this in a screen
 * (same convention as utils/game-result.ts):
 *
 * ```
 * player.isManaged === false ───────────────────► ACTIVE  (claimed via login)
 * isManaged ─┬─ any ACCEPTED invitation row ────► ACTIVE  (accepted via web
 *            │                                            link, never signed in)
 *            ├─ PENDING row, expiresAt future ──► INVITED
 *            ├─ PENDING row, expiresAt past ────► INVITE EXPIRED
 *            └─ otherwise ──────────────────────► NOT INVITED
 * ```
 *
 * The rows come from `GET /teams/:id` (`team.invitations`, roster managers
 * only, PENDING+ACCEPTED for ROSTERED players, never the token). Resend
 * actions must only target PENDING rows — a lazily-EXPIRED row has no valid
 * invitation id to resend; use a fresh supersede invite instead.
 */

export type RosterStatus = 'active' | 'invited' | 'invite_expired' | 'not_invited';

/** One row of `team.invitations` on `GET /teams/:id` (roster managers only). */
export interface TeamInvitationStatusRow {
  id: string;
  playerId: string;
  status: 'PENDING' | 'ACCEPTED';
  expiresAt: string;
  createdAt: string;
}

export interface RosterStatusResult {
  status: RosterStatus;
  /** The live or lapsed PENDING row, when one exists (cancel targets its id). */
  pendingInvitation?: TeamInvitationStatusRow;
}

export function getRosterStatus(
  member: { playerId: string; player: { isManaged?: boolean } },
  invitations: TeamInvitationStatusRow[] | undefined | null,
  now: Date = new Date()
): RosterStatusResult {
  // A claimed account (isManaged flipped off by first login) is always Active.
  if (member.player.isManaged === false) {
    return { status: 'active' };
  }

  const rows = (invitations ?? []).filter((row) => row.playerId === member.playerId);

  // Accepted via the public web link without ever signing in: the account is
  // still coach-managed, but the player said yes.
  if (rows.some((row) => row.status === 'ACCEPTED')) {
    return { status: 'active' };
  }

  const pending = rows.find((row) => row.status === 'PENDING');
  if (pending) {
    const expired = new Date(pending.expiresAt).getTime() <= now.getTime();
    return { status: expired ? 'invite_expired' : 'invited', pendingInvitation: pending };
  }

  return { status: 'not_invited' };
}

export function rosterStatusLabel(status: RosterStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'invited':
      return 'Invited';
    case 'invite_expired':
      return 'Invite expired';
    case 'not_invited':
      return 'Not invited';
  }
}

/**
 * Chip color per status, from the theme palette. `active` = success,
 * `invited` = primary, `invite_expired` = warning, `not_invited` = neutral.
 */
export function rosterStatusColor(
  status: RosterStatus,
  colors: { success: string; primary: string; warning: string; textSecondary: string }
): string {
  switch (status) {
    case 'active':
      return colors.success;
    case 'invited':
      return colors.primary;
    case 'invite_expired':
      return colors.warning;
    case 'not_invited':
      return colors.textSecondary;
  }
}
