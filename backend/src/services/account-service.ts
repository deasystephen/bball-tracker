/**
 * Account deletion and data export (#444, `docs/plans/account-deletion.md`).
 *
 * Deletion is ANONYMIZE-IN-PLACE: the `User` row becomes a tombstone
 * (`deletedAt` set, no email / login / photo, name replaced) so that
 * `GameEvent`, `PlayerStats` and `TeamMember` rows keep a valid target and
 * every other member's season stats stay coherent. Rows that only serve the
 * person are removed; rows that carry their personal data in other tables are
 * scrubbed. The one exception is an account nothing references once the purge
 * is done (#529): a tombstone protects other people's data, and such an account
 * never touched any, so the row is deleted outright ("erased"). One
 * `$transaction`, one code path for the three callers:
 *
 *   DELETE /auth/me ─────────────┐
 *   DELETE /players/:id/account ─┼─► deleteAccount(target, { mode })
 *   scripts/data-subject-request ┘
 *
 *   $transaction
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 1  SELECT … FROM "User" WHERE id=$1 OR id IN (my children)   │
 *   │    ORDER BY id FOR UPDATE (one statement, global lock order) │
 *   │    already deleted ────────────────────────────────► 404     │
 *   │    mode guardian and (claimed or not managed) ─────► 403     │
 *   │ 2  mode self|operator: lock my HEAD_COACH teams (id order),  │
 *   │    then lastHeadCoachTeams(active seasons)                   │
 *   │    non-empty ──────────────────► LastHeadCoachError 400      │
 *   │ 3  purge: pushToken, calendarFeedToken, teamStaff,           │
 *   │    leagueAdmin (log admin-less leagues), gameRsvp,           │
 *   │    guardian links both ways (+ promote next primary),        │
 *   │    PENDING team invitations → CANCELLED,                     │
 *   │    PENDING guardian invitations → EXPIRED,                   │
 *   │    every GuardianInvitation.invitedEmail match → sentinel,   │
 *   │    personal league → neutral name (deleted when empty),      │
 *   │    managedById = me → null                                   │
 *   │ 4  count what still points at the row (USER_REFERENCE_SELECT) │
 *   │    nothing ───────────► DELETE the User row (erased: true)    │
 *   │    anything ──────────► tombstone, deletedAt = now()          │
 *   └─────────────────────────────────────────────────────────────┘
 *   after commit, best-effort: delete the S3 avatar, delete the WorkOS user
 *
 * KEPT, de-identified: TeamMember, GameEvent, PlayerStats, Announcement, AnnouncementReply
 * (author), TeamInvitation rows the user SENT. Any of these (or any other
 * remaining relation) is what keeps the tombstone; the check is "nothing
 * references this row", never "no game events" (D1).
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
import { ConflictError, ForbiddenError, LastHeadCoachError, NotFoundError } from '../utils/errors';
import { lastHeadCoachTeams } from '../utils/permissions';
import { lockTeamRows } from '../utils/team-row-lock';
import { EMAIL_SUPPRESSION_CLEARED } from '../utils/email-suppression';
import { emailEquals } from '../utils/email-match';
import { USER_SUMMARY_SELECT } from '../utils/user-select';
import { deletePreviousAvatar, isManagedAvatarUrl, isOwnUploadUrl } from './upload-service';
import { GuardianService } from './guardian-service';
import { WorkOSService } from './workos-service';

/** The tombstone's display name. Clients render their own localized label from `deletedAt`. */
export const DELETED_USER_NAME = 'Deleted user';
/** Replaces `<Name>'s Teams` on a deleted coach's personal league that still holds teams. */
export const DELETED_LEAGUE_NAME = "Former coach's teams";

/**
 * Every list relation on `model User` whose rows point AT the user row,
 * counted in one query by the erasure check (#529). Exhaustive on purpose: a
 * relation missing here would let a hard delete cascade through rows other
 * people rely on, which is exactly what D1 forbids. The schema test in
 * `tests/services/account-service.test.ts` fails when `schema.prisma` gains a
 * relation on `User` that is named neither here, in `USER_REFERENCE_SELECT`,
 * nor in `USER_OUTBOUND_RELATIONS`.
 */
export const USER_REFERENCE_COUNT_SELECT = {
  managedPlayers: true,
  teamMembers: true,
  teamStaff: true,
  gameEvents: true,
  refreshTokens: true,
  sentInvitations: true,
  receivedInvitations: true,
  leagueAdmins: true,
  guardiansAsParent: true,
  guardiansAsChild: true,
  guardianInvitationsAsChild: true,
  sentGuardianInvitations: true,
  playerStats: true,
  gameRsvps: true,
  pushTokens: true,
  announcements: true,
  announcementReplies: true,
  calendarFeedTokens: true,
} satisfies Prisma.UserCountOutputTypeSelect;

/** The erasure check's select: the list-relation counts plus every one-to-one relation that points at the row. */
export const USER_REFERENCE_SELECT = {
  _count: { select: USER_REFERENCE_COUNT_SELECT },
  personalLeague: { select: { id: true } },
} satisfies Prisma.UserSelect;

/**
 * Relations on `model User` that point FROM the row (the user's own foreign
 * key) and therefore never keep it alive: deleting the row drops the pointer.
 */
export const USER_OUTBOUND_RELATIONS = ['managedBy'] as const;

type UserReferences = Prisma.UserGetPayload<{ select: typeof USER_REFERENCE_SELECT }>;

/** True when no row in any relation still points at the user (#529). */
export function isUnreferenced(refs: UserReferences): boolean {
  return refs.personalLeague === null && Object.values(refs._count).every((count) => count === 0);
}

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
  /**
   * `true` when the `User` row was deleted outright because nothing referenced
   * it after the purge (#529); `false` when it was tombstoned (D1). The
   * runbook's request log records which branch ran.
   */
  erased: boolean;
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

    // Each lock wait below (the User rows, then the Team rows) is bounded by
    // the pool-wide lock_timeout (models/pool-config.ts#DB_LOCK_TIMEOUT_MS,
    // #934 → #944): a delete stuck behind a holder has that statement
    // cancelled by PostgreSQL and answers the retryable 503, so no pool
    // connection stays pinned past the bound. Two waits in a row can still
    // reach Prisma's 5 s (same 503, P2028 flavour).
    const committed = await prisma.$transaction(async (tx) => {
      // 1. Lock the row. Concurrent deletes, self-writes and sign-ins serialize here.
      // The same statement locks every child this user guards (#664): the
      // purge below removes their links and promotes the next primary, which
      // must not interleave with an accept or removeGuardian for that child
      // (both lock the child through `utils/user-row-lock.ts#lockUsers`). One
      // statement in id order keeps the lock order global, so none of them can
      // deadlock against this one. The children share FOR UPDATE because one
      // statement has one strength; it is held only for this transaction.
      const locked = await tx.$queryRaw<LockedUserRow[]>`
        SELECT "id", "email", "workosUserId", "isManaged", "profilePictureUrl", "deletedAt"
        FROM "User"
        WHERE "id" = ${userId}
           OR "id" IN (SELECT "childId" FROM "Guardian" WHERE "parentId" = ${userId})
        ORDER BY "id"
        FOR UPDATE`;
      const row = locked.find((candidate) => candidate.id === userId);
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
        // Lock every team where this user is HEAD_COACH before the guard,
        // the lock `TeamService.removeStaffMember`/`changeStaffRole` take, so
        // deleting one head coach and removing the other cannot both pass
        // (#463). User rows were locked above: User before Team, never the
        // reverse. The set cannot grow meanwhile: a new TeamStaff row naming
        // this user needs a key-share lock on the User row we hold.
        const headCoachTeams = await tx.teamStaff.findMany({
          where: { userId, role: { type: 'HEAD_COACH' } },
          select: { teamId: true },
        });
        await lockTeamRows(
          tx,
          headCoachTeams.map((staff) => staff.teamId)
        );

        const blocking = await lastHeadCoachTeams(userId, tx, { activeSeasonsOnly: true });
        if (blocking.length > 0) {
          throw new LastHeadCoachError(blocking);
        }
      }

      // 3. Purge what only serves the person.
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

      await purgeLoginBindings(tx, userId);

      const emailMatch: Prisma.GuardianInvitationWhereInput[] = row.email
        ? [{ invitedEmail: emailEquals(row.email) }]
        : [];
      await tx.guardianInvitation.updateMany({
        where: { status: 'PENDING', OR: [{ childId: userId }, ...emailMatch] },
        data: { status: 'EXPIRED' },
      });
      if (row.email) {
        await scrubInvitedEmail(tx, row.email);
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

      // 4. Erase or tombstone (#529). Whatever still points at the row after
      // the purge is history other people rely on: membership, events, stats,
      // invitations either way, announcements. Nothing left → no reason to
      // keep the id, and the row goes. The purge above made every remaining
      // reference deliberate, so this is one query against a locked row.
      const refs = await tx.user.findUnique({ where: { id: userId }, select: USER_REFERENCE_SELECT });
      const erased = refs !== null && isUnreferenced(refs);
      if (erased) {
        await tx.user.delete({ where: { id: userId } });
      } else {
        await tx.user.update({
          where: { id: userId },
          data: {
            workosUserId: null,
            email: null,
            ...EMAIL_SUPPRESSION_CLEARED,
            name: DELETED_USER_NAME,
            emailVerified: false,
            profilePictureUrl: null,
            managedById: null,
            subscriptionTier: 'FREE',
            subscriptionExpiresAt: null,
            deletedAt: new Date(),
          },
        });
      }

      return { previousAvatar: row.profilePictureUrl, workosUserId: row.workosUserId, adminlessLeagueIds, erased };
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
      erased: committed.erased,
      adminlessLeagueIds: committed.adminlessLeagueIds,
    });

    return {
      success: true,
      identityDeleted,
      erased: committed.erased,
      adminlessLeagueIds: committed.adminlessLeagueIds,
    };
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
      ? [{ invitedEmail: emailEquals(user.email) }]
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
      announcementReplies,
      personalLeague,
    ] = await Promise.all([
      prisma.teamMember.findMany({ where: { playerId: userId }, include: TEAM_REF_INCLUDE }),
      prisma.teamStaff.findMany({ where: { userId }, include: STAFF_EXPORT_INCLUDE }),
      prisma.leagueAdmin.findMany({ where: { userId }, include: { league: { select: { id: true, name: true } } } }),
      prisma.guardian.findMany({ where: { parentId: userId }, include: GUARDIAN_CHILD_EXPORT_INCLUDE }),
      prisma.guardian.findMany({ where: { childId: userId }, include: GUARDIAN_PARENT_EXPORT_INCLUDE }),
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
      prisma.announcementReply.findMany({ where: { authorId: userId } }),
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
      announcementReplies,
    };
  }

  /**
   * Turns a signed-in account back into a managed roster record (#983): the
   * operator path for an account holder we learn is under 13
   * (`docs/runbooks/data-subject-requests.md`, "We learned an account holder
   * is under 13"; `scripts/convert-to-managed.ts`).
   *
   *   $transaction
   *   ┌──────────────────────────────────────────────────────────────────┐
   *   │ 1  unlocked: no live row ───────────────────────────────► 404      │
   *   │              already managed and unclaimed ─────────────► 409      │
   *   │ 2  SELECT … FOR UPDATE the player; both checks again              │
   *   │ 3  assertPlayerAccount: any adult signal ───────────────► 409      │
   *   │    (an empty personal league the child started is deleted)        │
   *   │ 4  managing coach: the operator's choice or the one head coach,   │
   *   │    staff on the player's active-season teams ──── else ─► 409      │
   *   │    SELECT … FOR KEY SHARE the coach; tombstoned ─────────► 409      │
   *   │ 5  unclaimManagedRow (shared with the age screen, #981)           │
   *   └──────────────────────────────────────────────────────────────────┘
   *   after commit, best-effort: delete the S3 avatar the child uploaded,
   *   delete the WorkOS user (ends every session); if that fails, revoke
   *   every active session and report identityDeleted: false
   *
   * What the locks protect. FOR UPDATE on the player (not FOR NO KEY UPDATE)
   * is the lock that blocks the key-share lock a new `TeamStaff`,
   * `LeagueAdmin`, `Guardian`, `TeamInvitation` or managed-player row naming
   * the player takes, so the adult signals read in step 3 cannot change
   * before commit, and a concurrent deletion or sign-in on the row waits. The
   * coach's key-share lock conflicts with the FOR UPDATE account deletion
   * takes, so the coach cannot be tombstoned between the liveness check and
   * commit; a deletion that runs after commit clears `managedById` as it does
   * for every record that coach managed. Staff rows are not locked: a coach
   * removed from the team meanwhile still manages the record, as after any
   * staff change.
   */
  static async convertToManaged(userId: string, options: ConvertToManagedOptions): Promise<ConvertToManagedResult> {
    const { actorId } = options;

    const committed = await prisma.$transaction(async (tx) => {
      // 1. Cheap unlocked checks, so a mistyped id reads as "not found" and a
      // re-run reads as "already converted", not as a coach problem.
      assertConvertible(
        await tx.user.findUnique({
          where: { id: userId },
          select: { deletedAt: true, isManaged: true, workosUserId: true },
        })
      );

      // 2. Lock the player; the checks again, now authoritative.
      const [row] = await tx.$queryRaw<LockedUserRow[]>`
        SELECT "id", "email", "workosUserId", "isManaged", "profilePictureUrl", "deletedAt"
        FROM "User"
        WHERE "id" = ${userId}
        FOR UPDATE`;
      assertConvertible(row);

      // 3. A player account, not an adult's.
      await assertPlayerAccount(tx, userId);

      // 4. Who manages the record, resolved once under the player's lock.
      const managedById = await resolveManagingCoach(tx, userId, options.managedById);
      const [coach] = await tx.$queryRaw<{ deletedAt: Date | null }[]>`
        SELECT "deletedAt" FROM "User" WHERE "id" = ${managedById} FOR KEY SHARE`;
      if (!coach || coach.deletedAt !== null) {
        throw new ConflictError("The managing coach's account no longer exists; run it again or pass --coach");
      }

      // 5. Un-claim.
      const unclaimed = await unclaimManagedRow(tx, row, managedById);
      return { ...unclaimed, managedById };
    });

    await deletePreviousAvatar(committed.removedAvatar, null);

    let identityDeleted: boolean | null = null;
    let sessions: SessionRevocation | null = null;
    if (committed.workosUserId) {
      try {
        await WorkOSService.deleteUser(committed.workosUserId);
        identityDeleted = true;
      } catch (error) {
        identityDeleted = false;
        logger.error('Failed to delete WorkOS user after converting an account to managed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        captureException(error, { flow: 'convert-to-managed', userId });
        // The row no longer resolves the identity, but a refresh token would
        // still mint access tokens until WorkOS ends the session.
        try {
          sessions = await WorkOSService.revokeAllSessions(committed.workosUserId);
        } catch (revokeError) {
          logger.error('Failed to list WorkOS sessions after converting an account to managed', {
            userId,
            error: revokeError instanceof Error ? revokeError.message : String(revokeError),
          });
        }
        if (sessions !== null && sessions.failed > 0) {
          logger.error('Failed to revoke some WorkOS sessions after converting an account to managed', {
            userId,
            revoked: sessions.revoked,
            failed: sessions.failed,
          });
        }
      }
    }

    logger.info('Account converted to managed', {
      userId,
      actorId,
      managedById: committed.managedById,
      identityDeleted,
    });

    return {
      success: true,
      managedById: committed.managedById,
      identityDeleted,
      // The operator needs the provider id to finish the deletion by hand: the
      // row no longer holds it, nor the email to search by.
      ...(identityDeleted === false && committed.workosUserId && { workosUserId: committed.workosUserId, sessions }),
    };
  }
}

export interface ConvertToManagedOptions {
  /** Who ran it; `operator` from the script. Logged, never stored. */
  actorId: string;
  /**
   * The coach who manages the record from now on: staff on one of the
   * player's teams in an active season. Optional: by default the one head
   * coach of those teams.
   */
  managedById?: string;
}

/** Outcome of `WorkOSService.revokeAllSessions`. */
export interface SessionRevocation {
  revoked: number;
  failed: number;
}

export interface ConvertToManagedResult {
  success: true;
  managedById: string;
  /**
   * `true`: the WorkOS user was deleted. `false`: it exists and deleting it
   * failed (finish by hand). `null`: the row had no WorkOS identity.
   */
  identityDeleted: boolean | null;
  /** Only when `identityDeleted` is `false`: the id to delete by hand. */
  workosUserId?: string;
  /**
   * Only with `workosUserId`: the session fallback's outcome, `null` when the
   * sessions could not even be listed. Fully revoked only when `failed` is 0.
   */
  sessions?: SessionRevocation | null;
}

/** The checks that hold for a row about to be converted, before and under the lock. */
function assertConvertible(
  row: Pick<LockedUserRow, 'deletedAt' | 'isManaged' | 'workosUserId'> | null | undefined
): asserts row is NonNullable<typeof row> {
  if (!row || row.deletedAt !== null) {
    throw new NotFoundError('Account not found');
  }
  if (row.isManaged && row.workosUserId === null) {
    throw new ConflictError('Account is already a managed roster record; nothing to do');
  }
}

/** The teams a player counts as "currently on": rostered, in an active season. */
function currentTeamsOf(playerId: string): Prisma.TeamWhereInput {
  return { season: { isActive: true }, members: { some: { playerId } } };
}

/**
 * Who manages the converted record: staff on a team the player is rostered on
 * in an active season. An operator-supplied id must qualify, so a typo cannot
 * hand a child's record to a stranger or to a coach from a past season.
 * Without one, the head coach of those teams, when exactly one person holds
 * that role.
 */
async function resolveManagingCoach(
  tx: Prisma.TransactionClient,
  playerId: string,
  requested: string | undefined
): Promise<string> {
  if (requested) {
    const staff = await tx.teamStaff.findFirst({
      where: { userId: requested, user: { deletedAt: null }, team: currentTeamsOf(playerId) },
      select: { userId: true },
    });
    if (!staff) {
      throw new ConflictError("The coach given is not on the staff of any of this player's teams in an active season");
    }
    return staff.userId;
  }

  const heads = await tx.teamStaff.findMany({
    where: { role: { type: 'HEAD_COACH' }, user: { deletedAt: null }, team: currentTeamsOf(playerId) },
    select: { userId: true },
    distinct: ['userId'],
  });
  if (heads.length !== 1) {
    throw new ConflictError(
      heads.length === 0
        ? 'The player is on no team in an active season with a head coach; pass a coach id or delete the account instead'
        : 'The player has more than one head coach across active teams; pass the coach id to use'
    );
  }
  return heads[0].userId;
}

const ADULT_SIGNALS_SELECT = {
  _count: {
    select: {
      teamStaff: true,
      guardiansAsParent: true,
      managedPlayers: true,
      sentInvitations: true,
      sentGuardianInvitations: true,
    },
  },
  leagueAdmins: { select: { leagueId: true } },
  personalLeague: { select: { id: true } },
} satisfies Prisma.UserSelect;

/**
 * Refuses an account that is an adult's: a staff role, a guardian-of link,
 * players it manages, team or guardian invitations it sent (a former coach
 * still on some roster), admin of a league other than its own personal
 * league, or a personal league that holds teams or has another admin. A child
 * who once started creating a team has a personal league and admins it; when
 * nothing else is in it, the league is deleted (its admin row goes with it by
 * cascade), as account deletion removes an empty one (D16). Runs under the
 * player's FOR UPDATE lock.
 */
async function assertPlayerAccount(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const signals = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: ADULT_SIGNALS_SELECT });
  const personalLeagueId = signals.personalLeague?.id ?? null;
  const adminElsewhere = signals.leagueAdmins.some(({ leagueId }) => leagueId !== personalLeagueId);
  if (adminElsewhere || Object.values(signals._count).some((count) => count > 0)) {
    throw new ConflictError(
      'Account holds a staff or league admin role, guardian links, managed players or sent invitations: it is an adult account, not a player. Delete it instead'
    );
  }
  if (personalLeagueId !== null) {
    const teamCount = await tx.team.count({ where: { season: { leagueId: personalLeagueId } } });
    const otherAdmins = await tx.leagueAdmin.count({ where: { leagueId: personalLeagueId, userId: { not: userId } } });
    if (teamCount > 0 || otherAdmins > 0) {
      throw new ConflictError(
        'Account owns a personal league with teams or other admins: it is a coach, not a player. Delete it instead'
      );
    }
    await tx.league.delete({ where: { id: personalLeagueId } });
  }
}

/** The locked row `unclaimManagedRow` works from; the caller reads it under its lock. */
export type UnclaimTarget = Pick<LockedUserRow, 'id' | 'email' | 'workosUserId' | 'profilePictureUrl'>;

/**
 * The un-claim write: a signed-in account becomes a managed roster record
 * again, the state a coach's Add Player left it in before the child signed
 * in (#983; the age screen's under-13 branch, #981, reuses it). The caller
 * holds the row's FOR UPDATE lock, read `row` under it, has checked the row is
 * live and claimable, and chose `managedById`; it also logs the domain event
 * and, after commit, deletes the WorkOS user and the returned avatar.
 *
 * - Login and contact: `workosUserId` and `email` are cleared (the email too,
 *   so a fresh sign-up with the same address cannot claim the row again
 *   through `syncUser`'s email match), `emailVerified` false, suppression
 *   state cleared with the email.
 * - Guardian invitations that invited the child's address to be someone
 *   else's guardian are expired and the address overwritten (D17).
 *   Invitations FOR this child (to a parent, maybe at a shared family
 *   address) stay: they are how the record gets its guardian.
 * - `isManaged` true, `managedById` the coach, role back to `PLAYER`,
 *   subscription back to free.
 * - Photo: kept only when it is an upload under the `avatars/<id>/` prefix of
 *   the managing coach or another staff member of the player's active-season
 *   teams (a photo the team took). Anything else is cleared, external URLs
 *   included: the identity provider's photo is copied at claim time, and an
 *   external URL cannot be told apart from it. The S3 object is deleted
 *   (returned as `removedAvatar`) only when it is the child's own upload.
 * - `purgeLoginBindings`: push tokens, calendar feed tokens, pending team
 *   invitations cancelled and their recipient hash cleared.
 *
 * Roster memberships, game events, stats, RSVPs and guardian links stay: the
 * coach's view of the roster does not change.
 */
export async function unclaimManagedRow(
  tx: Prisma.TransactionClient,
  row: UnclaimTarget,
  managedById: string
): Promise<{ workosUserId: string | null; removedAvatar: string | null }> {
  const userId = row.id;
  const photo = row.profilePictureUrl;
  let clearPhoto = false;
  let removedAvatar: string | null = null;
  if (photo !== null) {
    const staff = await tx.teamStaff.findMany({
      where: { team: currentTeamsOf(userId) },
      select: { userId: true },
      distinct: ['userId'],
    });
    const teamUploaders = new Set([managedById, ...staff.map((member) => member.userId)]);
    teamUploaders.delete(userId);
    const takenByTeam =
      isManagedAvatarUrl(photo) && [...teamUploaders].some((uploaderId) => isOwnUploadUrl(photo, uploaderId));
    clearPhoto = !takenByTeam;
    removedAvatar = clearPhoto && isManagedAvatarUrl(photo) && isOwnUploadUrl(photo, userId) ? photo : null;
  }

  const updated = await tx.user.updateMany({
    where: { id: userId, deletedAt: null },
    data: {
      workosUserId: null,
      email: null,
      ...EMAIL_SUPPRESSION_CLEARED,
      emailVerified: false,
      isManaged: true,
      managedById,
      role: 'PLAYER',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
      ...(clearPhoto && { profilePictureUrl: null }),
    },
  });
  if (updated.count === 0) {
    throw new NotFoundError('Account not found');
  }

  await purgeLoginBindings(tx, userId);
  if (row.email) {
    await tx.guardianInvitation.updateMany({
      where: { status: 'PENDING', invitedEmail: emailEquals(row.email), childId: { not: userId } },
      data: { status: 'EXPIRED' },
    });
    await scrubInvitedEmail(tx, row.email, { exceptChildId: userId });
  }

  return { workosUserId: row.workosUserId, removedAvatar };
}

/**
 * What lets a login or an inbox reach the person, removed by both account
 * deletion and the un-claim: push tokens, calendar feed tokens, PENDING team
 * invitations addressed to them (→ CANCELLED, they invite a sign-in), and the
 * hash of the address every team invitation went to (#715 resend cooldown;
 * the invitation rows themselves outlive the account).
 */
async function purgeLoginBindings(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.pushToken.deleteMany({ where: { userId } });
  await tx.calendarFeedToken.deleteMany({ where: { userId } });
  await tx.teamInvitation.updateMany({
    where: { playerId: userId, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  await tx.teamInvitation.updateMany({
    where: { playerId: userId, recipientHash: { not: null } },
    data: { recipientHash: null },
  });
}

/**
 * D17: the address must not survive on any guardian invitation, ACCEPTED and
 * EXPIRED rows included. Per-row sentinel keeps NOT NULL and cannot collide;
 * the partial unique index covers PENDING rows only, and the caller expired
 * those first. `exceptChildId` leaves the invitations for that child alone
 * (the un-claim keeps the invitations to the child's parent).
 */
async function scrubInvitedEmail(
  tx: Prisma.TransactionClient,
  email: string,
  options: { exceptChildId?: string } = {}
): Promise<void> {
  const exceptChild = options.exceptChildId ? Prisma.sql`AND "childId" <> ${options.exceptChildId}` : Prisma.empty;
  await tx.$executeRaw`
    UPDATE "GuardianInvitation"
    SET "invitedEmail" = 'deleted-' || "id" || '@invalid'
    WHERE lower("invitedEmail") = lower(${email}) ${exceptChild}`;
}

// Named select/include constants so the export type is explicit (CLAUDE.md
// code style) and the runbook can list the export contract from one place.
const USER_EXPORT_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
  // Delivery state SES reported for the address (#449): data held about the person.
  emailSuppressedAt: true,
  emailSuppressedReason: true,
  profilePictureUrl: true,
  subscriptionTier: true,
  subscriptionExpiresAt: true,
  isManaged: true,
  managedById: true,
  notifyOnReplies: true,
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

/** The other side of a guardian link, in the shared user shape (#813). */
const GUARDIAN_CHILD_EXPORT_INCLUDE = { child: { select: USER_SUMMARY_SELECT } } satisfies Prisma.GuardianInclude;
const GUARDIAN_PARENT_EXPORT_INCLUDE = { parent: { select: USER_SUMMARY_SELECT } } satisfies Prisma.GuardianInclude;

/** Everything `exportUserData` returns; the runbook lists these keys as the export contract. */
export interface UserDataExport {
  exportedAt: Date;
  user: Prisma.UserGetPayload<{ select: typeof USER_EXPORT_SELECT }>;
  personalLeague: { id: string; name: string } | null;
  teamMembers: Prisma.TeamMemberGetPayload<{ include: typeof TEAM_REF_INCLUDE }>[];
  teamStaff: Prisma.TeamStaffGetPayload<{ include: typeof STAFF_EXPORT_INCLUDE }>[];
  leagueAdmins: Prisma.LeagueAdminGetPayload<{ include: { league: { select: { id: true; name: true } } } }>[];
  guardiansAsParent: Prisma.GuardianGetPayload<{ include: typeof GUARDIAN_CHILD_EXPORT_INCLUDE }>[];
  guardiansAsChild: Prisma.GuardianGetPayload<{ include: typeof GUARDIAN_PARENT_EXPORT_INCLUDE }>[];
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
  announcementReplies: Prisma.AnnouncementReplyGetPayload<Record<string, never>>[];
}
