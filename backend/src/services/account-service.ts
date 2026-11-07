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
import {
  ConvertRefusedError,
  ForbiddenError,
  LastHeadCoachError,
  NotFoundError,
  UnauthorizedError,
  UnderMinimumAgeError,
} from '../utils/errors';
import { lastHeadCoachTeams } from '../utils/permissions';
import { lockTeamRows } from '../utils/team-row-lock';
import { EMAIL_SUPPRESSION_CLEARED } from '../utils/email-suppression';
import { emailEquals } from '../utils/email-match';
import { USER_SUMMARY_SELECT } from '../utils/user-select';
import {
  type AvatarDeletion,
  deleteAvatarObject,
  deletePreviousAvatar,
  isManagedAvatarUrl,
  isOwnUploadUrl,
} from './upload-service';
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
      if (
        personal &&
        !(await deletePersonalLeagueIfEmpty(
          tx,
          personal.id,
          await tx.team.count({ where: { season: { leagueId: personal.id } } })
        ))
      ) {
        await tx.league.update({
          where: { id: personal.id },
          data: { name: DELETED_LEAGUE_NAME, personalOwnerId: null },
        });
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
            ageConfirmedAt: null,
            ageRefusedAt: null,
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
   * The age screen's "old enough" branch (#981): record that the account
   * holder confirmed the minimum age. Idempotent: a row already confirmed is
   * left as it is. The answer itself never reaches this method.
   */
  static async confirmAge(userId: string): Promise<void> {
    const updated = await prisma.user.updateMany({
      where: { id: userId, deletedAt: null, ageConfirmedAt: null, ageRefusedAt: null },
      data: { ageConfirmedAt: new Date() },
    });
    if (updated.count === 0) {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { deletedAt: true, ageConfirmedAt: true, ageRefusedAt: true },
      });
      if (!row || row.deletedAt !== null) {
        throw new UnauthorizedError('User not found');
      }
      if (row.ageRefusedAt !== null) {
        // The earlier answer was final; the operator finishes by the runbook.
        throw new UnderMinimumAgeError();
      }
      return;
    }
    logger.info('Age confirmed', { userId });
  }

  /**
   * The age screen's "under the minimum" branch (#981): undo the sign-in so
   * that nothing collected from the child is kept, then end the login.
   *
   *   $transaction (the player, and the coach who would take the record,
   *   FOR UPDATE in one id-ordered statement; the branch is read before and
   *   again under the lock, as convertToManaged does)
   *   ┌──────────────────────────────────────────────────────────────────┐
   *   │ no live row ───────────────────────────────────────────► 404      │
   *   │ already refused, awaiting the operator ────────────────► no-op    │
   *   │ adult signals (assertPlayerAccount), or on no roster ──► DELETE   │
   *   │ a player on a roster ──► un-claim (unclaimManagedRow) ─► UNCLAIMED│
   *   │     managing coach: the one head coach of the player's active-    │
   *   │     season teams, else null (an ADMIN can still edit the record)  │
   *   └──────────────────────────────────────────────────────────────────┘
   *   DELETE runs `deleteAccount` in `self` mode after the decision commits:
   *   erased when nothing references the row (a sign-up that answered the
   *   question and left), tombstoned otherwise. A sole head coach of an
   *   active-season team cannot be deleted that way; the answer is recorded
   *   as final (`ageRefusedAt`: the gate stays shut and a second answer is
   *   refused, so the live access token cannot confirm its way back in), the
   *   session is revoked and an operator finishes by the runbook: outcome
   *   `pending_operator`, logged at error and sent to Sentry.
   *   After an un-claim commits, best-effort: the cleared photo's S3 object,
   *   then the WorkOS user (a 404 counts as gone), falling back to revoking
   *   every session.
   *
   * The row is the one `authenticate` just resolved for the request, so the
   * caller holds a valid token; a dev-login row has no WorkOS user and the
   * provider steps are skipped. Nothing about the answer is passed in.
   */
  static async refuseUnderage(userId: string, options: RefuseUnderageOptions = {}): Promise<RefuseUnderageResult> {
    const decision = await prisma.$transaction(async (tx) => {
      // 1. Unlocked: which branch, and which coach would take the record. The
      // coach must be named in the lock statement, so it is resolved first and
      // re-checked under the lock (the order convertToManaged uses).
      const preview = await tx.user.findUnique({
        where: { id: userId },
        select: { deletedAt: true, ageRefusedAt: true },
      });
      if (!preview || preview.deletedAt !== null) {
        throw new NotFoundError('Account not found');
      }
      if (preview.ageRefusedAt !== null) {
        // Already refused and awaiting the operator: nothing more to undo.
        return { kind: 'already_refused' as const };
      }
      const branch = await underageBranch(tx, userId);
      const candidateCoach = branch.kind === 'unclaim' ? branch.managedById : null;

      // 2. Lock the player (and the coach, when there is one) in one id-ordered
      // statement, the lock order deletion and conversion use.
      const ids = candidateCoach ? [userId, candidateCoach] : [userId];
      const locked = await tx.$queryRaw<LockedUserRow[]>`
        SELECT "id", "email", "workosUserId", "isManaged", "profilePictureUrl", "deletedAt"
        FROM "User"
        WHERE "id" IN (${Prisma.join(ids)})
        ORDER BY "id"
        FOR UPDATE`;
      const row = locked.find((candidate) => candidate.id === userId);
      if (!row || row.deletedAt !== null) {
        throw new NotFoundError('Account not found');
      }

      // 3. The branch again, under the lock.
      const settled = await underageBranch(tx, userId);
      if (settled.kind === 'delete') {
        return { kind: 'delete' as const };
      }
      // The coach qualifies only if the lock caught a live row and the choice
      // held; otherwise the record is kept with no manager (an ADMIN can edit
      // it), never refused: the under-age answer must land.
      const coach = locked.find((candidate) => candidate.id === settled.managedById);
      const managedById =
        settled.managedById !== null && settled.managedById === candidateCoach && coach && coach.deletedAt === null
          ? settled.managedById
          : null;
      if (settled.emptyPersonalLeagueId !== null) {
        await deletePersonalLeagueIfEmpty(tx, settled.emptyPersonalLeagueId, 0);
      }
      const unclaimed = await unclaimManagedRow(tx, row, managedById);
      return { kind: 'unclaimed' as const, ...unclaimed, workosUserId: row.workosUserId, managedById };
    });

    if (decision.kind === 'already_refused') {
      logger.info('Under-age answer refused', { userId, outcome: 'pending_operator', identityDeleted: false, repeat: true });
      return { outcome: 'pending_operator', identityDeleted: false };
    }

    if (decision.kind === 'delete') {
      try {
        const deleted = await AccountService.deleteAccount(userId, {
          actorId: userId,
          mode: 'self',
          sessionId: options.sessionId,
        });
        const outcome: UnderageOutcome = deleted.erased ? 'erased' : 'deleted';
        logger.info('Under-age answer refused', { userId, outcome, identityDeleted: deleted.identityDeleted });
        return { outcome, identityDeleted: deleted.identityDeleted };
      } catch (error) {
        if (!(error instanceof LastHeadCoachError)) throw error;
        // The account cannot go yet (live teams would be left headless). The
        // answer is recorded as final: the gate stays shut on every route and
        // a second answer is refused, so the holder cannot confirm their way
        // back in while the access token lives. The operator takes it from here.
        await prisma.user.updateMany({
          where: { id: userId, deletedAt: null },
          data: { ageRefusedAt: new Date() },
        });
        let sessionRevoked = false;
        if (options.sessionId) {
          try {
            await WorkOSService.revokeSession(options.sessionId);
            sessionRevoked = true;
          } catch (revokeError) {
            logger.error('Failed to revoke WorkOS session after an under-age answer', {
              userId,
              error: revokeError instanceof Error ? revokeError.message : String(revokeError),
            });
          }
        }
        logger.error('Under-age answer could not be applied automatically; operator action required', {
          userId,
          reason: 'last_head_coach',
          sessionRevoked,
        });
        captureException(new Error('Under-age answer on a sole head coach account needs an operator'), {
          flow: 'age-refusal',
          userId,
        });
        logger.info('Under-age answer refused', { userId, outcome: 'pending_operator', identityDeleted: false });
        return { outcome: 'pending_operator', identityDeleted: false };
      }
    }

    const photoDeletion: PhotoDeletion =
      decision.removedAvatar === null ? 'none' : await deleteAvatarObject(decision.removedAvatar);
    if (photoDeletion === 'failed') {
      logger.error('Failed to delete the photo object after an under-age un-claim', { userId });
    }

    const identity: IdentityTeardown =
      decision.workosUserId === null
        ? { identityDeleted: true, sessions: null }
        : await deleteIdentityOrRevokeSessions(decision.workosUserId, { userId, flow: 'age-refusal' });

    logger.info('Under-age answer refused', {
      userId,
      outcome: 'unclaimed',
      managedById: decision.managedById,
      identityDeleted: identity.identityDeleted,
      ...(identity.identityNote && { identityNote: identity.identityNote }),
      photoDeletion,
      deletedReplyCount: decision.deletedReplyCount,
      expiredGuardianInvitations: decision.expiredGuardianInvitations.length,
    });
    return { outcome: 'unclaimed', identityDeleted: identity.identityDeleted };
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
   *   │ 1  unlocked read: no live row ──────────────────────────► 404      │
   *   │    never signed in, or already managed (a re-run) ──────► 409      │
   *   │    any adult signal (assertPlayerAccount) ──────────────► 409      │
   *   │    managing coach: the operator's choice or the one head coach,   │
   *   │    staff on the player's active-season teams ──── else ─► 409      │
   *   │ 2  SELECT … FOR UPDATE player + coach, one id-ordered statement   │
   *   │    the step-1 checks again; coach tombstoned or the choice        │
   *   │    changed ─────────────────────────────────────────────► 409      │
   *   │ 3  adult signals again, one read, under the lock ───────► 409      │
   *   │    an empty personal league the child started is deleted (D16)    │
   *   │ 4  unclaimManagedRow (shared with the age screen, #981)           │
   *   └──────────────────────────────────────────────────────────────────┘
   *   after commit, best-effort, both reported: delete the cleared photo's
   *   S3 object (photoDeletion), delete the WorkOS user (a 404 counts as
   *   gone) (ends its WorkOS sessions and refresh tokens;
   *   an open Socket.io connection lasts until its access token expires,
   *   #1004); if that fails, revoke every active session and report
   *   identityDeleted: false
   *
   * Locks. The player and the coach are locked FOR UPDATE in ONE statement in
   * id order, the order and strength account deletion uses for a user and
   * the children they guard, so this and a deletion of either can wait on
   * each other but not deadlock. FOR UPDATE on the player blocks the
   * key-share lock that a new `TeamStaff`, `LeagueAdmin`, `Guardian`,
   * invitation, announcement or managed-player row naming the player takes,
   * so the adult signals read in step 3 cannot change before commit. FOR
   * UPDATE on the coach keeps the coach from being tombstoned before commit;
   * a deletion after commit clears `managedById` as it does for every record
   * that coach managed. The coach is chosen before the lock (the statement
   * must name both rows) and the choice is re-checked under it. Staff rows
   * are not locked: a coach removed from the team meanwhile still manages the
   * record, as after any staff change.
   */
  static async convertToManaged(userId: string, options: ConvertToManagedOptions): Promise<ConvertToManagedResult> {
    const { actorId } = options;

    const committed = await prisma.$transaction(async (tx) => {
      // 1. Unlocked: a mistyped id reads as "not found", a re-run as "already
      // converted" and an adult as "adult account", all before the coach
      // (whom the lock must name) is resolved: a re-run's team may have no
      // head coach left, and an unrostered adult must not be told to "delete,
      // no active team" on the strength of a coach lookup.
      assertConvertible(
        await tx.user.findUnique({
          where: { id: userId },
          select: { deletedAt: true, isManaged: true, workosUserId: true },
        })
      );
      assertPlayerAccount(await tx.user.findUniqueOrThrow({ where: { id: userId }, select: ADULT_SIGNALS_SELECT }));
      const managedById = await resolveManagingCoach(tx, userId, options.managedById);

      // 2. Lock the player and the coach, then the checks again.
      const locked = await tx.$queryRaw<LockedUserRow[]>`
        SELECT "id", "email", "workosUserId", "isManaged", "profilePictureUrl", "deletedAt"
        FROM "User"
        WHERE "id" IN (${Prisma.join([userId, managedById])})
        ORDER BY "id"
        FOR UPDATE`;
      const row = locked.find((candidate) => candidate.id === userId);
      assertConvertible(row);
      const coach = locked.find((candidate) => candidate.id === managedById);
      if (!coach || coach.deletedAt !== null) {
        throw new ConvertRefusedError('coach_unavailable', "The managing coach's account no longer exists");
      }
      if ((await resolveManagingCoach(tx, userId, options.managedById)) !== managedById) {
        throw new ConvertRefusedError('coaches_changed', "The player's coaches changed while converting");
      }

      // 3. A player account, not an adult's: authoritative now, under the lock.
      const signals = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: ADULT_SIGNALS_SELECT });
      const emptyPersonalLeagueId = assertPlayerAccount(signals);
      if (emptyPersonalLeagueId !== null) {
        // Known empty: the team count came from the read above.
        await deletePersonalLeagueIfEmpty(tx, emptyPersonalLeagueId, 0);
      }

      // 4. Un-claim.
      const unclaimed = await unclaimManagedRow(tx, row, managedById);
      return { ...unclaimed, workosUserId: row.workosUserId, managedById };
    });

    // The photo is a picture of the child that nobody could find once the row
    // lets go of it: its deletion is reported, never silent.
    const photoDeletion: PhotoDeletion =
      committed.removedAvatar === null ? 'none' : await deleteAvatarObject(committed.removedAvatar);
    if (photoDeletion === 'failed') {
      logger.error('Failed to delete the photo object after converting an account to managed', { userId });
    }

    // A converted row always had a WorkOS identity: assertConvertible refuses
    // an unclaimed one. The id is not personal data; it is logged on failure
    // so the operator can finish the deletion without the terminal output.
    const { workosUserId } = committed;
    const { identityDeleted, identityNote, sessions } = await deleteIdentityOrRevokeSessions(workosUserId, {
      userId,
      flow: 'convert-to-managed',
    });

    logger.info('Account converted to managed', {
      userId,
      actorId,
      managedById: committed.managedById,
      identityDeleted,
      ...(identityNote && { identityNote }),
      ...(!identityDeleted && { workosUserId }),
      photoDeletion,
      deletedReplyCount: committed.deletedReplyCount,
    });

    return {
      success: true,
      managedById: committed.managedById,
      identityDeleted,
      ...(identityNote && { identityNote }),
      photoDeletion,
      expiredGuardianInvitations: committed.expiredGuardianInvitations,
      deletedReplyCount: committed.deletedReplyCount,
      // The operator needs the provider id to finish the deletion by hand: the
      // row no longer holds it, nor the email to search by.
      ...(!identityDeleted && { workosUserId, sessions }),
    };
  }
}

/** Why `identityDeleted` is true without a deletion having happened. */
export type IdentityNote = 'not_found_at_workos';

/**
 * The cleared photo's S3 object after commit: `none` when no object was ours
 * to delete (no photo, kept, external, or another row still shows it), else
 * `deleteAvatarObject`'s outcome. `failed` must be finished by hand.
 */
export type PhotoDeletion = 'none' | AvatarDeletion;

/** What `refuseUnderage` did with the account (#981). */
export type UnderageOutcome = 'erased' | 'deleted' | 'unclaimed' | 'pending_operator';

export interface RefuseUnderageOptions {
  /** The caller's WorkOS session id (`sid`), for revocation when the user cannot be deleted. */
  sessionId?: string;
}

export interface RefuseUnderageResult {
  outcome: UnderageOutcome;
  /** Whether the WorkOS user is gone (true for a row that never had one). */
  identityDeleted: boolean;
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
   * `true`: the WorkOS user is gone (deleted now, or WorkOS answered 404, see
   * `identityNote`). `false`: deleting it failed (finish by hand).
   */
  identityDeleted: boolean;
  /** Set when WorkOS already had no such user (404): nothing was deleted. */
  identityNote?: IdentityNote;
  /** The cleared photo's S3 object; `failed` must be deleted by hand before replying. */
  photoDeletion: PhotoDeletion;
  /**
   * PENDING guardian invitations sent to the child's address, for any child,
   * expired by the conversion: the operator asks each child's coach to
   * re-invite the parent at a parent's address.
   */
  expiredGuardianInvitations: ExpiredGuardianInvitation[];
  /** Announcement replies the child wrote, deleted by the conversion. */
  deletedReplyCount: number;
  /** Only when `identityDeleted` is `false`: the id to delete by hand. */
  workosUserId?: string;
  /**
   * Only with `workosUserId`: the session fallback's outcome, `null` when the
   * sessions could not even be listed. Fully revoked only when `failed` is 0.
   */
  sessions?: SessionRevocation | null;
}

/** What `deleteIdentityOrRevokeSessions` reports. */
export interface IdentityTeardown {
  identityDeleted: boolean;
  identityNote?: IdentityNote;
  /** Only after a failed deletion: the fallback's counts, `null` when the sessions could not be listed. */
  sessions: SessionRevocation | null;
}

/**
 * End a WorkOS identity after the row let go of it (the conversion and the
 * age screen's un-claim share this; deletion revokes one session instead,
 * `deleteAccount`). Delete the user (a 404 counts as gone: already deleted, or
 * a Staging id left after the production-key cutover, #24); on any other
 * failure report to Sentry and revoke every session, so a refresh token cannot
 * mint access tokens while the id is still known to WorkOS. Every failure is
 * logged with the id (not personal data) so the operator can finish by hand.
 */
async function deleteIdentityOrRevokeSessions(
  workosUserId: string,
  context: { userId: string; flow: 'convert-to-managed' | 'age-refusal' }
): Promise<IdentityTeardown> {
  const { userId, flow } = context;
  try {
    await WorkOSService.deleteUser(workosUserId);
    return { identityDeleted: true, sessions: null };
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) {
      return { identityDeleted: true, identityNote: 'not_found_at_workos', sessions: null };
    }
    logger.error('Failed to delete WorkOS user after releasing the account', {
      userId,
      workosUserId,
      flow,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, { flow, userId });
    let sessions: SessionRevocation | null = null;
    try {
      sessions = await WorkOSService.revokeAllSessions(workosUserId);
    } catch (revokeError) {
      logger.error('Failed to list WorkOS sessions after releasing the account', {
        userId,
        workosUserId,
        flow,
        error: revokeError instanceof Error ? revokeError.message : String(revokeError),
      });
    }
    if (sessions !== null && sessions.failed > 0) {
      logger.error('Failed to revoke some WorkOS sessions after releasing the account', {
        userId,
        workosUserId,
        flow,
        revoked: sessions.revoked,
        failed: sessions.failed,
      });
    }
    return { identityDeleted: false, sessions };
  }
}

/** Which way the age screen's under-minimum branch goes for a row (#981); read unlocked, then again under the lock. */
type UnderageBranch =
  | { kind: 'delete' }
  | { kind: 'unclaim'; managedById: string | null; emptyPersonalLeagueId: string | null };

async function underageBranch(tx: Prisma.TransactionClient, userId: string): Promise<UnderageBranch> {
  const signals = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: ADULT_SIGNALS_SELECT });
  let emptyPersonalLeagueId: string | null;
  try {
    emptyPersonalLeagueId = assertPlayerAccount(signals);
  } catch (error) {
    if (error instanceof ConvertRefusedError) return { kind: 'delete' };
    throw error;
  }
  const onRoster = (await tx.teamMember.count({ where: { playerId: userId } })) > 0;
  if (!onRoster) return { kind: 'delete' };
  let managedById: string | null = null;
  try {
    managedById = await resolveManagingCoach(tx, userId, undefined);
  } catch (error) {
    if (!(error instanceof ConvertRefusedError)) throw error;
  }
  return { kind: 'unclaim', managedById, emptyPersonalLeagueId };
}

/** The checks that hold for a row about to be converted, before and under its lock. */
function assertConvertible<T extends Pick<LockedUserRow, 'deletedAt' | 'isManaged' | 'workosUserId'>>(
  row: T | null | undefined
): asserts row is T & { workosUserId: string } {
  if (!row || row.deletedAt !== null) {
    throw new NotFoundError('Account not found');
  }
  if (row.workosUserId === null) {
    throw row.isManaged
      ? new ConvertRefusedError('already_managed', 'Account is already a managed roster record; nothing to do')
      : new ConvertRefusedError('never_signed_in', 'Account has never signed in; nothing to convert');
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
      throw new ConvertRefusedError(
        'coach_not_on_team',
        "The chosen coach is not on the staff of any of this player's teams in an active season"
      );
    }
    return staff.userId;
  }

  const heads = await tx.teamStaff.findMany({
    where: { role: { type: 'HEAD_COACH' }, user: { deletedAt: null }, team: currentTeamsOf(playerId) },
    select: { userId: true },
    distinct: ['userId'],
  });
  if (heads.length === 1) {
    return heads[0].userId;
  }
  if (heads.length > 1) {
    throw new ConvertRefusedError('several_head_coaches', "The player's active teams have more than one head coach");
  }
  const onActiveTeam = await tx.team.count({ where: currentTeamsOf(playerId) });
  throw onActiveTeam === 0
    ? new ConvertRefusedError('no_active_team', 'The player is on no team in an active season: there is no roster to keep the record on')
    : new ConvertRefusedError('no_head_coach', "No team the player is on in an active season has a head coach");
}

/** Invitations that were really sent; a cancelled one is a stray, not a sign of a coach. */
const SENT_FOR_REAL = { where: { status: { not: 'CANCELLED' } } } satisfies {
  where: Prisma.TeamInvitationWhereInput & Prisma.GuardianInvitationWhereInput;
};

/** Every adult signal in one read, taken under the player's FOR UPDATE lock. */
const ADULT_SIGNALS_SELECT = {
  role: true,
  _count: {
    select: {
      teamStaff: true,
      guardiansAsParent: true,
      managedPlayers: true,
      announcements: true,
      sentInvitations: SENT_FOR_REAL,
      sentGuardianInvitations: SENT_FOR_REAL,
    },
  },
  leagueAdmins: { select: { leagueId: true } },
  personalLeague: {
    select: { id: true, _count: { select: { admins: true } }, seasons: { select: { _count: { select: { teams: true } } } } },
  },
} satisfies Prisma.UserSelect;

type AdultSignals = Prisma.UserGetPayload<{ select: typeof ADULT_SIGNALS_SELECT }>;

/**
 * Refuses an account that is an adult's: the global ADMIN role, a staff
 * role, a guardian-of link, players it manages, announcements it posted,
 * team or guardian invitations it sent and did not cancel (a former coach
 * still on some roster), admin of a league other than its own personal
 * league, or a personal league that holds teams or has another admin.
 * Returns the id of an empty personal league the child once started (the
 * caller deletes it, D16), or `null`. Reads nothing and writes nothing.
 */
function assertPlayerAccount(signals: AdultSignals): string | null {
  const personal = signals.personalLeague;
  const adminElsewhere = signals.leagueAdmins.some(({ leagueId }) => leagueId !== personal?.id);
  // The global role is read here as a refusal signal, never as an access
  // check (the CLAUDE.md rule is about granting access): a system ADMIN is an
  // adult by construction. COACH is not a signal: anyone, a child included,
  // can pick it at onboarding; what a real coach did shows up as staff rows,
  // invitations, announcements or a personal league with teams.
  if (signals.role === 'ADMIN' || adminElsewhere || Object.values(signals._count).some((count) => count > 0)) {
    throw new ConvertRefusedError(
      'adult_account',
      'Account is a system admin, or holds a staff or league admin role, guardian links, managed players, announcements or sent invitations: it is an adult account, not a player'
    );
  }
  if (personal === null) {
    return null;
  }
  const ownAdminRows = signals.leagueAdmins.filter(({ leagueId }) => leagueId === personal.id).length;
  const teams = personal.seasons.reduce((sum, season) => sum + season._count.teams, 0);
  if (teams > 0 || personal._count.admins > ownAdminRows) {
    throw new ConvertRefusedError(
      'personal_league_in_use',
      'Account owns a personal league with teams or other admins: it is a coach, not a player'
    );
  }
  return personal.id;
}

/**
 * D16, shared by account deletion and the un-claim: a personal league with
 * no teams is deleted (its seasons and admin rows go with it by cascade). The
 * caller supplies the team count it read (deletion counts; the un-claim has
 * it from its locked read). Returns whether it was deleted; one that holds
 * teams is left to the caller.
 */
async function deletePersonalLeagueIfEmpty(
  tx: Prisma.TransactionClient,
  leagueId: string,
  teamCount: number
): Promise<boolean> {
  if (teamCount > 0) {
    return false;
  }
  await tx.league.delete({ where: { id: leagueId } });
  return true;
}

/** The locked row `unclaimManagedRow` works from; the caller reads it under its lock. */
export type UnclaimTarget = Pick<LockedUserRow, 'id' | 'email' | 'workosUserId' | 'profilePictureUrl'>;

/**
 * The un-claim write: a signed-in account becomes a managed roster record
 * again, the state a coach's Add Player left it in before the child signed
 * in (#983; the age screen's under-13 branch, #981, reuses it). The caller
 * holds the row's FOR UPDATE lock, read `row` under it, has checked the row is
 * live, claimable and not an adult's, and chose `managedById`; it also logs
 * the domain event and, after commit, deletes the WorkOS user and the
 * returned avatar.
 *
 * DELETED (what identifies or reaches the child, or what the child wrote):
 * - login and contact: `workosUserId` and `email` (so a fresh sign-up with
 *   the same address cannot claim the row again through `syncUser`'s email
 *   match), `emailVerified`, the address's suppression state;
 * - the photo, unless it is an upload under the `avatars/<id>/` prefix of the
 *   managing coach or another live staff member of the player's
 *   active-season teams (a photo the team took). External URLs are cleared
 *   too: the identity provider's photo is copied at claim time and cannot be
 *   told apart. A cleared photo in our bucket is returned as `removedAvatar`
 *   for deletion, whoever uploaded it, unless another user row still shows it;
 * - announcement replies the child wrote (the only free text a player can
 *   author; announcements themselves are an adult signal the caller refused);
 * - `purgeLoginBindings`: push tokens, calendar feed tokens, pending team
 *   invitations (→ CANCELLED) and their recipient hash;
 * - the child's address on every guardian invitation that carries it, any
 *   status, any child (D17, `scrubInvitedEmail`), after every PENDING one is
 *   expired. Every expired one is returned with its `childId`: accepting one
 *   for this child would have created a PARENT account at the child's
 *   address, and one for another child was waiting on the child as guardian,
 *   so the operator asks each child's coach to re-invite at a parent's
 *   address. An accepted `Guardian` link is a separate row and stays.
 *
 * RESET: `isManaged` true, `managedById` the coach (null when the age screen
 * found no single head coach to hand the record to, #981: an ADMIN can still
 * edit it, as for any record whose coach left), role `PLAYER`, free tier,
 * `ageConfirmedAt` null.
 *
 * KEPT: `name` (a roster record needs one, and it is what the coach entered
 * or sees on the roster; the coach can edit it), and the team records:
 * roster memberships, game events, stats, RSVPs, guardian links, and guardian
 * invitations for the child at other addresses.
 */
export async function unclaimManagedRow(
  tx: Prisma.TransactionClient,
  row: UnclaimTarget,
  managedById: string | null
): Promise<UnclaimResult> {
  const userId = row.id;
  const photo = row.profilePictureUrl;
  let clearPhoto = false;
  let removedAvatar: string | null = null;
  if (photo !== null) {
    const staff = await tx.teamStaff.findMany({
      where: { user: { deletedAt: null }, team: currentTeamsOf(userId) },
      select: { userId: true },
      distinct: ['userId'],
    });
    const teamUploaders = new Set([...(managedById ? [managedById] : []), ...staff.map((member) => member.userId)]);
    teamUploaders.delete(userId);
    const takenByTeam =
      isManagedAvatarUrl(photo) && [...teamUploaders].some((uploaderId) => isOwnUploadUrl(photo, uploaderId));
    clearPhoto = !takenByTeam;
    if (clearPhoto && isManagedAvatarUrl(photo)) {
      // A photo of the child in our bucket that nobody could find again once
      // cleared: delete the object, whoever uploaded it, unless another row
      // still shows it.
      const sharedWith = await tx.user.count({ where: { profilePictureUrl: photo, id: { not: userId } } });
      removedAvatar = sharedWith === 0 ? photo : null;
    }
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
      // The age answer belonged to the login that is being undone (#981);
      // the next person to claim the row answers again.
      ageConfirmedAt: null,
      ageRefusedAt: null,
      ...(clearPhoto && { profilePictureUrl: null }),
    },
  });
  if (updated.count === 0) {
    throw new NotFoundError('Account not found');
  }

  const replies = await tx.announcementReply.deleteMany({ where: { authorId: userId } });
  await purgeLoginBindings(tx, userId);

  let expiredGuardianInvitations: ExpiredGuardianInvitation[] = [];
  if (row.email) {
    expiredGuardianInvitations = await tx.guardianInvitation.findMany({
      where: { status: 'PENDING', invitedEmail: emailEquals(row.email) },
      select: { id: true, childId: true },
      orderBy: { id: 'asc' },
    });
    await tx.guardianInvitation.updateMany({
      where: { id: { in: expiredGuardianInvitations.map((invitation) => invitation.id) } },
      data: { status: 'EXPIRED' },
    });
    await scrubInvitedEmail(tx, row.email);
  }

  return {
    workosUserId: row.workosUserId,
    removedAvatar,
    expiredGuardianInvitations,
    deletedReplyCount: replies.count,
  };
}

/** A guardian invitation the un-claim expired, and the child it was for. */
export interface ExpiredGuardianInvitation {
  id: string;
  childId: string;
}

export interface UnclaimResult {
  workosUserId: string | null;
  /** A photo object of the child to delete from S3 after commit. */
  removedAvatar: string | null;
  /** Every PENDING guardian invitation sent to the child's address (any child), expired here. */
  expiredGuardianInvitations: ExpiredGuardianInvitation[];
  /** Announcement replies the child wrote, deleted here. */
  deletedReplyCount: number;
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
 * D17, shared by account deletion and the un-claim: the address must not
 * survive on any guardian invitation, whatever its status or child.
 * Per-row sentinel keeps NOT NULL and cannot collide; the partial unique
 * index covers PENDING rows only, and the caller expired those first.
 * Overwriting `invitedEmail` on an ACCEPTED row leaves the `Guardian` link it
 * created untouched.
 */
async function scrubInvitedEmail(tx: Prisma.TransactionClient, email: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "GuardianInvitation"
    SET "invitedEmail" = 'deleted-' || "id" || '@invalid'
    WHERE lower("invitedEmail") = lower(${email})`;
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
