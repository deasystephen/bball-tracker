/**
 * Account deletion and data export (#444, `docs/plans/account-deletion.md`).
 *
 * Deletion is ANONYMIZE-IN-PLACE, never a hard delete: the `User` row becomes
 * a tombstone (`deletedAt` set, no email / login / photo, name replaced) so
 * that `GameEvent`, `PlayerStats` and `TeamMember` rows keep a valid target
 * and every other member's season stats stay coherent. Rows that only serve
 * the person are removed; rows that carry their personal data in other tables
 * are scrubbed. One `$transaction`, one code path for the three callers:
 *
 *   DELETE /auth/me ─────────────┐
 *   DELETE /players/:id/account ─┼─► deleteAccount(target, { mode })
 *   scripts/data-subject-request ┘
 *
 *   $transaction
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 1  SELECT … FROM "User" WHERE id=$1 FOR UPDATE               │
 *   │    already deleted ────────────────────────────────► 404     │
 *   │    mode guardian and (claimed or not managed) ─────► 403     │
 *   │ 2  mode self|operator: lastHeadCoachTeams(active seasons)    │
 *   │    non-empty ──────────────────► LastHeadCoachError 400      │
 *   │ 3  purge: pushToken, calendarFeedToken, teamStaff,           │
 *   │    leagueAdmin (log admin-less leagues), gameRsvp,           │
 *   │    guardian links both ways (+ promote next primary),        │
 *   │    PENDING team invitations → CANCELLED,                     │
 *   │    PENDING guardian invitations → EXPIRED,                   │
 *   │    every GuardianInvitation.invitedEmail match → sentinel,   │
 *   │    personal league → neutral name (deleted when empty),      │
 *   │    managedById = me → null                                   │
 *   │ 4  tombstone the User row, deletedAt = now()                 │
 *   └─────────────────────────────────────────────────────────────┘
 *   after commit, best-effort: delete the S3 avatar, delete the WorkOS user
 *
 * KEPT, de-identified: TeamMember, GameEvent, PlayerStats, Announcement
 * (author), TeamInvitation rows the user SENT.
 *
 * The row lock is what makes "the identity cannot come back" true: every
 * other write onto a User row (`PATCH /auth/me`, `/me/role`, push-token
 * registration, both `syncUser` branches) is conditioned on
 * `deletedAt IS NULL`, so a request that authenticated a moment before this
 * commits finds zero rows instead of re-identifying the tombstone.
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { ForbiddenError, LastHeadCoachError, NotFoundError } from '../utils/errors';
import { lastHeadCoachTeams } from '../utils/permissions';
import { deletePreviousAvatar } from './upload-service';
import { GuardianService } from './guardian-service';
import { WorkOSService } from './workos-service';

/** The tombstone's display name. Clients render their own localized label from `deletedAt`. */
export const DELETED_USER_NAME = 'Deleted user';
/** Replaces `<Name>'s Teams` on a deleted coach's personal league that still holds teams. */
export const DELETED_LEAGUE_NAME = "Former coach's teams";

/**
 * Who is asking, and therefore which gate applies.
 * - `self`: the account owner (`DELETE /auth/me`). Last-head-coach rule applies.
 * - `guardian`: a guardian deleting a managed, unclaimed child's record. The
 *   route pre-checks; the service re-checks under the lock (D5).
 * - `operator`: the data-subject-request script, identity verified by hand.
 *   Skips the owner/guardian gate, keeps the last-head-coach rule.
 */
export type DeleteAccountMode = 'self' | 'guardian' | 'operator';

export interface DeleteAccountOptions {
  actorId: string;
  mode: DeleteAccountMode;
  /**
   * The caller's WorkOS session id (`sid` claim), when known. Used only as a
   * fallback: if deleting the WorkOS user fails, the session is revoked so the
   * device's refresh token dies anyway.
   */
  sessionId?: string;
}

export interface DeleteAccountResult {
  success: true;
  /** Whether the WorkOS user was deleted (false for managed/dev accounts and on provider failure). */
  identityDeleted: boolean;
  /** Real leagues left with zero admins — the runbook's post-deletion checklist (D18). */
  adminlessLeagueIds: string[];
}

interface LockedUserRow {
  id: string;
  email: string | null;
  workosUserId: string | null;
  isManaged: boolean;
  profilePictureUrl: string | null;
  deletedAt: Date | null;
}

export class AccountService {
  static async deleteAccount(userId: string, options: DeleteAccountOptions): Promise<DeleteAccountResult> {
    const { actorId, mode } = options;

    const committed = await prisma.$transaction(async (tx) => {
      // 1. Lock the row. Concurrent deletes, self-writes and sign-ins serialize here.
      const locked = await tx.$queryRaw<LockedUserRow[]>`
        SELECT "id", "email", "workosUserId", "isManaged", "profilePictureUrl", "deletedAt"
        FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const row = locked[0];
      if (!row || row.deletedAt !== null) {
        throw new NotFoundError('Account not found');
      }
      if (mode === 'guardian' && (!row.isManaged || row.workosUserId !== null)) {
        // Re-checked under the lock: a child who claimed the account between
        // the route's pre-check and this point owns it now.
        throw new ForbiddenError('Only the account owner can delete a claimed account');
      }

      // 2. A head coach must hand over live teams first (D4). Managed
      // children hold no staff rows, so guardian mode skips the query.
      if (mode !== 'guardian') {
        const blocking = await lastHeadCoachTeams(userId, tx, { activeSeasonsOnly: true });
        if (blocking.length > 0) {
          throw new LastHeadCoachError(blocking);
        }
      }

      // 3. Purge what only serves the person.
      await tx.pushToken.deleteMany({ where: { userId } });
      await tx.calendarFeedToken.deleteMany({ where: { userId } });
      await tx.teamStaff.deleteMany({ where: { userId } });
      await tx.gameRsvp.deleteMany({ where: { userId } });

      const adminOf = await tx.leagueAdmin.findMany({ where: { userId }, select: { leagueId: true } });
      await tx.leagueAdmin.deleteMany({ where: { userId } });

      const asParent = await tx.guardian.findMany({
        where: { parentId: userId },
        select: { childId: true, isPrimary: true },
      });
      await tx.guardian.deleteMany({ where: { parentId: userId } });
      for (const link of asParent) {
        if (link.isPrimary) {
          await GuardianService.promoteNextPrimary(tx, link.childId);
        }
      }
      await tx.guardian.deleteMany({ where: { childId: userId } });

      await tx.teamInvitation.updateMany({
        where: { playerId: userId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });

      const emailMatch: Prisma.GuardianInvitationWhereInput[] = row.email
        ? [{ invitedEmail: { equals: row.email, mode: 'insensitive' } }]
        : [];
      await tx.guardianInvitation.updateMany({
        where: { status: 'PENDING', OR: [{ childId: userId }, ...emailMatch] },
        data: { status: 'EXPIRED' },
      });
      if (row.email) {
        // D17: the address must not survive on ACCEPTED / EXPIRED rows either.
        // Per-row sentinel keeps NOT NULL and cannot collide; the partial
        // unique index covers PENDING rows only, and those were just expired.
        await tx.$executeRaw`
          UPDATE "GuardianInvitation"
          SET "invitedEmail" = 'deleted-' || "id" || '@invalid'
          WHERE lower("invitedEmail") = lower(${row.email})`;
      }

      // D16: the personal league carries the coach's name.
      const personal = await tx.league.findUnique({
        where: { personalOwnerId: userId },
        select: { id: true },
      });
      if (personal) {
        const teamCount = await tx.team.count({ where: { season: { leagueId: personal.id } } });
        if (teamCount === 0) {
          await tx.league.delete({ where: { id: personal.id } });
        } else {
          await tx.league.update({
            where: { id: personal.id },
            data: { name: DELETED_LEAGUE_NAME, personalOwnerId: null },
          });
        }
      }

      // Real leagues the user administered that now have nobody (D18).
      const adminlessLeagueIds: string[] = [];
      for (const { leagueId } of adminOf) {
        if (personal && leagueId === personal.id) continue;
        const remaining = await tx.leagueAdmin.count({ where: { leagueId } });
        if (remaining === 0) adminlessLeagueIds.push(leagueId);
      }

      // Roster players this coach created stay managed; nobody but an ADMIN
      // can edit them afterwards, same as today once the creator leaves (B2.10).
      await tx.user.updateMany({ where: { managedById: userId }, data: { managedById: null } });

      // 4. Tombstone.
      await tx.user.update({
        where: { id: userId },
        data: {
          workosUserId: null,
          email: null,
          name: DELETED_USER_NAME,
          emailVerified: false,
          profilePictureUrl: null,
          managedById: null,
          subscriptionTier: 'FREE',
          subscriptionExpiresAt: null,
          deletedAt: new Date(),
        },
      });

      return { previousAvatar: row.profilePictureUrl, workosUserId: row.workosUserId, adminlessLeagueIds };
    });

    // 5. After commit: best-effort external cleanup. The local row is already
    // unreachable, so a failure here never fails the request.
    await deletePreviousAvatar(committed.previousAvatar, null);

    let identityDeleted = false;
    if (committed.workosUserId) {
      try {
        await WorkOSService.deleteUser(committed.workosUserId);
        identityDeleted = true;
      } catch (error) {
        logger.error('Failed to delete WorkOS user after account deletion', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        captureException(error, { flow: 'account-delete', userId });
        if (options.sessionId) {
          try {
            await WorkOSService.revokeSession(options.sessionId);
          } catch (revokeError) {
            logger.error('Failed to revoke WorkOS session after account deletion', {
              userId,
              error: revokeError instanceof Error ? revokeError.message : String(revokeError),
            });
          }
        }
      }
    }

    logger.info('Account deleted', {
      userId,
      actorId,
      mode,
      identityDeleted,
      adminlessLeagueIds: committed.adminlessLeagueIds,
    });

    return { success: true, identityDeleted, adminlessLeagueIds: committed.adminlessLeagueIds };
  }

  /**
   * Everything the system holds about a user, as one JSON-serializable
   * object (data-subject export, `docs/runbooks/data-subject-requests.md`).
   * `workosUserId` is deliberately omitted (an internal provider key).
   */
  static async exportUserData(userId: string): Promise<UserDataExport> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: USER_EXPORT_SELECT });
    if (!user) {
      throw new NotFoundError('Account not found');
    }

    const emailOr: Prisma.GuardianInvitationWhereInput[] = user.email
      ? [{ invitedEmail: { equals: user.email, mode: 'insensitive' } }]
      : [];

    const [
      teamMembers,
      teamStaff,
      leagueAdmins,
      guardiansAsParent,
      guardiansAsChild,
      receivedInvitations,
      sentInvitations,
      guardianInvitations,
      sentGuardianInvitations,
      gameRsvps,
      gameEvents,
      playerStats,
      pushTokens,
      calendarFeedTokens,
      announcements,
      personalLeague,
    ] = await Promise.all([
      prisma.teamMember.findMany({ where: { playerId: userId }, include: TEAM_REF_INCLUDE }),
      prisma.teamStaff.findMany({ where: { userId }, include: STAFF_EXPORT_INCLUDE }),
      prisma.leagueAdmin.findMany({ where: { userId }, include: { league: { select: { id: true, name: true } } } }),
      prisma.guardian.findMany({ where: { parentId: userId }, include: { child: { select: { id: true, name: true } } } }),
      prisma.guardian.findMany({ where: { childId: userId }, include: { parent: { select: { id: true, name: true } } } }),
      prisma.teamInvitation.findMany({ where: { playerId: userId }, select: RECEIVED_INVITATION_SELECT }),
      prisma.teamInvitation.findMany({ where: { invitedById: userId }, select: SENT_INVITATION_SELECT }),
      prisma.guardianInvitation.findMany({
        where: { OR: [{ childId: userId }, ...emailOr] },
        select: GUARDIAN_INVITATION_EXPORT_SELECT,
      }),
      prisma.guardianInvitation.findMany({ where: { invitedById: userId }, select: SENT_GUARDIAN_INVITATION_SELECT }),
      prisma.gameRsvp.findMany({ where: { userId } }),
      prisma.gameEvent.findMany({ where: { playerId: userId }, orderBy: { createdAt: 'asc' } }),
      prisma.playerStats.findMany({ where: { playerId: userId } }),
      prisma.pushToken.findMany({ where: { userId }, select: { platform: true, createdAt: true, updatedAt: true } }),
      prisma.calendarFeedToken.findMany({ where: { userId }, select: { teamId: true, revokedAt: true, createdAt: true } }),
      prisma.announcement.findMany({ where: { authorId: userId } }),
      prisma.league.findUnique({ where: { personalOwnerId: userId }, select: { id: true, name: true } }),
    ]);

    return {
      exportedAt: new Date(),
      user,
      personalLeague,
      teamMembers,
      teamStaff,
      leagueAdmins,
      guardiansAsParent,
      guardiansAsChild,
      receivedInvitations,
      sentInvitations,
      guardianInvitations,
      sentGuardianInvitations,
      gameRsvps,
      gameEvents,
      playerStats,
      pushTokens,
      calendarFeedTokens,
      announcements,
    };
  }
}

// Named select/include constants so the export type is explicit (CLAUDE.md
// code style) and the runbook can list the export contract from one place.
const USER_EXPORT_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
  profilePictureUrl: true,
  subscriptionTier: true,
  subscriptionExpiresAt: true,
  isManaged: true,
  managedById: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

const TEAM_REF_INCLUDE = {
  team: { select: { id: true, name: true, season: { select: { name: true, league: { select: { name: true } } } } } },
} satisfies Prisma.TeamMemberInclude;

const STAFF_EXPORT_INCLUDE = {
  team: TEAM_REF_INCLUDE.team,
  role: { select: { type: true, name: true } },
} satisfies Prisma.TeamStaffInclude;

const RECEIVED_INVITATION_SELECT = {
  id: true,
  teamId: true,
  status: true,
  jerseyNumber: true,
  position: true,
  message: true,
  expiresAt: true,
  createdAt: true,
  acceptedAt: true,
  rejectedAt: true,
} satisfies Prisma.TeamInvitationSelect;

const SENT_INVITATION_SELECT = {
  id: true,
  teamId: true,
  playerId: true,
  status: true,
  createdAt: true,
} satisfies Prisma.TeamInvitationSelect;

const GUARDIAN_INVITATION_EXPORT_SELECT = {
  id: true,
  childId: true,
  teamId: true,
  invitedEmail: true,
  relationship: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  acceptedAt: true,
} satisfies Prisma.GuardianInvitationSelect;

const SENT_GUARDIAN_INVITATION_SELECT = {
  id: true,
  childId: true,
  teamId: true,
  status: true,
  createdAt: true,
} satisfies Prisma.GuardianInvitationSelect;

/** Everything `exportUserData` returns; the runbook lists these keys as the export contract. */
export interface UserDataExport {
  exportedAt: Date;
  user: Prisma.UserGetPayload<{ select: typeof USER_EXPORT_SELECT }>;
  personalLeague: { id: string; name: string } | null;
  teamMembers: Prisma.TeamMemberGetPayload<{ include: typeof TEAM_REF_INCLUDE }>[];
  teamStaff: Prisma.TeamStaffGetPayload<{ include: typeof STAFF_EXPORT_INCLUDE }>[];
  leagueAdmins: Prisma.LeagueAdminGetPayload<{ include: { league: { select: { id: true; name: true } } } }>[];
  guardiansAsParent: Prisma.GuardianGetPayload<{ include: { child: { select: { id: true; name: true } } } }>[];
  guardiansAsChild: Prisma.GuardianGetPayload<{ include: { parent: { select: { id: true; name: true } } } }>[];
  receivedInvitations: Prisma.TeamInvitationGetPayload<{ select: typeof RECEIVED_INVITATION_SELECT }>[];
  sentInvitations: Prisma.TeamInvitationGetPayload<{ select: typeof SENT_INVITATION_SELECT }>[];
  guardianInvitations: Prisma.GuardianInvitationGetPayload<{ select: typeof GUARDIAN_INVITATION_EXPORT_SELECT }>[];
  sentGuardianInvitations: Prisma.GuardianInvitationGetPayload<{ select: typeof SENT_GUARDIAN_INVITATION_SELECT }>[];
  gameRsvps: Prisma.GameRsvpGetPayload<Record<string, never>>[];
  gameEvents: Prisma.GameEventGetPayload<Record<string, never>>[];
  playerStats: Prisma.PlayerStatsGetPayload<Record<string, never>>[];
  pushTokens: { platform: string; createdAt: Date; updatedAt: Date }[];
  calendarFeedTokens: { teamId: string; revokedAt: Date | null; createdAt: Date }[];
  announcements: Prisma.AnnouncementGetPayload<Record<string, never>>[];
}
