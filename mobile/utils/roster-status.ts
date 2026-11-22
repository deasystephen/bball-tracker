/**
 * Roster invite-status chips (roster/invite unification spec,
 * docs/plans/roster-invite-unification-spec.md).
 *
 * Derivation mirrors the backend rule exactly — never inline this in a screen
 * (same convention as utils/game-result.ts):
 *
 * ```
 * player.deletedAt set ─────────────────────────► DELETED (account deletion, #444;
 *                                                          checked FIRST — the
 *                                                          tombstone has isManaged
 *                                                          false, which would read
 *                                                          as Active)
 * player.isManaged === false ───────────────────► ACTIVE  (claimed via login)
 * isManaged ─┬─ any ACCEPTED invitation row ────► ACTIVE  (accepted via web
 *            │                                            link, never signed in)
 *            ├─ PENDING row, expiresAt future ──► INVITED
 *            ├─ PENDING row, expiresAt past ────► INVITE EXPIRED
 *            ├─ a linked parent/guardian ───────► PARENT CONNECTED
 *            ├─ PENDING guardian row, live ─────► PARENT INVITED
 *            ├─ PENDING guardian row, lapsed ───► PARENT INVITE EXPIRED
 *            └─ otherwise ──────────────────────► NOT INVITED
 * ```
 *
 * The three parent states (#1082) are the guardian path: a child under 13 has
 * no invitation of their own, the parent has one. They come from
 * `team.guardianInvitations` (PENDING only, never the address or the token) and
 * `team.guardianLinkedPlayerIds`, both roster-manager only. The player's own
 * invitation wins when there is one.
 *
 * The rows come from `GET /teams/:id` (`team.invitations`, roster managers
 * only, PENDING+ACCEPTED for ROSTERED players, never the token). Resend
 * actions must only target PENDING rows — a lazily-EXPIRED row has no valid
 * invitation id to resend; use a fresh supersede invite instead.
 */

import { i18n } from '../i18n';

import { isInvitationExpired } from './invitation-expiry';

export type RosterStatus =
  | 'deleted'
  | 'active'
  | 'invited'
  | 'invite_expired'
  | 'parent_connected'
  | 'parent_invited'
  | 'parent_invite_expired'
  | 'not_invited';

/** One row of `team.invitations` on `GET /teams/:id` (roster managers only). */
export interface TeamInvitationStatusRow {
  id: string;
  playerId: string;
  status: 'PENDING' | 'ACCEPTED';
  expiresAt: string;
  createdAt: string;
}

/** One row of `team.guardianInvitations` on `GET /teams/:id` (roster managers only, #1082). */
export interface GuardianInvitationStatusRow {
  id: string;
  playerId: string;
  status: 'PENDING';
  expiresAt: string;
  createdAt: string;
}

/** The parent/guardian side of one roster row, from the team payload. */
export interface RosterGuardianState {
  invitations?: GuardianInvitationStatusRow[] | null;
  /** At least one parent or guardian is linked to the player. */
  linked?: boolean;
}

export interface RosterStatusResult {
  status: RosterStatus;
  /** The live or lapsed PENDING row, when one exists (cancel targets its id). */
  pendingInvitation?: TeamInvitationStatusRow;
}

export function getRosterStatus(
  member: { playerId: string; player: { isManaged?: boolean; deletedAt?: string | null } },
  invitations: TeamInvitationStatusRow[] | undefined | null,
  now: Date = new Date(),
  guardian: RosterGuardianState = {}
): RosterStatusResult {
  // A deleted account stays on the roster as a tombstone (#444 D10); no
  // invite action applies to it, only Remove from team.
  if (member.player.deletedAt) {
    return { status: 'deleted' };
  }

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
    // Shared rule with the case-3 list (utils/invitation-expiry): notably a
    // malformed date counts as expired, never as a live invite.
    const expired = isInvitationExpired(pending.expiresAt, now);
    return { status: expired ? 'invite_expired' : 'invited', pendingInvitation: pending };
  }

  // The guardian path (#1082): no invitation of the player's own.
  if (guardian.linked) {
    return { status: 'parent_connected' };
  }
  const parentRows = (guardian.invitations ?? []).filter(
    (row) => row.playerId === member.playerId && row.status === 'PENDING'
  );
  if (parentRows.length > 0) {
    // One live invitation is enough: a second parent's lapsed one does not
    // make the player read as expired.
    const live = parentRows.some((row) => !isInvitationExpired(row.expiresAt, now));
    return { status: live ? 'parent_invited' : 'parent_invite_expired' };
  }

  return { status: 'not_invited' };
}

export function rosterStatusLabel(status: RosterStatus): string {
  switch (status) {
    case 'deleted':
      return i18n.t('roster.status.deleted');
    case 'active':
      return i18n.t('roster.status.active');
    case 'invited':
      return i18n.t('roster.status.invited');
    case 'invite_expired':
      return i18n.t('roster.status.inviteExpired');
    case 'parent_connected':
      return i18n.t('roster.status.parentConnected');
    case 'parent_invited':
      return i18n.t('roster.status.parentInvited');
    case 'parent_invite_expired':
      return i18n.t('roster.status.parentInviteExpired');
    case 'not_invited':
      return i18n.t('roster.status.notInvited');
  }
}

/**
 * Chip color per status, from the theme palette. `active` = success,
 * `invited` = primary, `invite_expired` = warning, `not_invited` and
 * `deleted` = neutral. The parent states take the colour of their own-invite
 * counterpart.
 */
export function rosterStatusColor(
  status: RosterStatus,
  colors: { success: string; primary: string; warning: string; textSecondary: string }
): string {
  switch (status) {
    case 'deleted':
      return colors.textSecondary;
    case 'active':
    case 'parent_connected':
      return colors.success;
    case 'invited':
    case 'parent_invited':
      return colors.primary;
    case 'invite_expired':
    case 'parent_invite_expired':
      return colors.warning;
    case 'not_invited':
      return colors.textSecondary;
  }
}
