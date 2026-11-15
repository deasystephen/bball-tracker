/**
 * Staff invitations by email (#460): club coach onboarding.
 *
 * `POST /teams/:teamId/staff` adds an EXISTING account only and answers 404
 * for an address with none. This service invites any address to a staff role
 * through a `StaffInvitation`, the third invitation kind next to
 * `TeamInvitation` (players) and `GuardianInvitation` (PARENT role), with the
 * same machinery: a random bearer-secret token read back only through
 * `STAFF_INVITATION_SELECT` (and stripped again by `omitToken` at the route),
 * lazy expiry, Resend = supersede in one transaction, a hand-written partial
 * unique index on PENDING, `emailEquals` for every address match and the
 * lower-cased address at rest, the shared resend cooldown, and a per-send
 * `emailSent` flag that reports a failed SES send instead of throwing.
 *
 * The consent rule (the claim-by-email hazard in `WorkOSService.syncUser`):
 * any `User` row holding an address with a null `workosUserId` is claimed by
 * whoever first signs in with that address, so a pre-provisioned row is a
 * standing grant of whatever hangs off it. This flow therefore creates NO
 * `User` row at invite time. The invitation holds only the address; the
 * account (when the address has none) and the `TeamStaff` row are created on
 * accept, by the person who holds the emailed link or is signed in with the
 * address. Declining strips the address from the invitation row (the
 * rejection-only strip of the player flow), keeping only its hash for the
 * cooldown. Detail: docs/architecture/roster-and-invitations.md, Staff
 * invitations.
 */

import { Prisma, TeamRoleType, UserRole } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import prisma from '../models';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  SignInRequiredError,
} from '../utils/errors';
import { canManageStaff } from '../utils/permissions';
import { assertResendCooldown } from '../utils/resend-cooldown';
import { createOrConflict, orNotFound } from '../utils/prisma-errors';
import { emailEquals, isSameEmail } from '../utils/email-match';
import { hashRecipient } from '../utils/hash-recipient';
import { lockTeamRow } from '../utils/team-row-lock';
import { lockUsers } from '../utils/user-row-lock';
import { logger } from '../utils/logger';
import { formatEmailDate } from '../utils/format-date';
import { withTimeout } from '../utils/promise-timeout';
import { publicAppUrl } from '../utils/urls';
import { mailer } from './mailer';
import { staffInvitationTemplate } from './mailer/templates';
import { TEAM_STAFF_INCLUDE, TeamService, type TeamStaffWithRelations } from './team-service';
import type { StaffRoleType } from '../api/teams/schemas';

const STAFF_INVITE_EXPIRES_DAYS = 7;

/** The partial unique index that allows one PENDING row per team + address. */
const PENDING_STAFF_INDEX = 'StaffInvitation_pending_teamId_invitedEmail_key';
const PENDING_STAFF_CONFLICT = 'A pending staff invitation already exists for this email';
const ALREADY_STAFF = 'This person is already a staff member of this team';
const INVITER_LOST_RIGHT =
  "This invitation is no longer valid: the coach who sent it can no longer manage this team's staff";

/** Same bound as the other invitation sends: well under the mobile client's 10s timeout. */
const EMAIL_SEND_TIMEOUT_MS = 5_000;

/** Scalar fields safe to return on authenticated responses: no `token`, no `recipientHash`. */
export const STAFF_INVITATION_SELECT = {
  id: true,
  teamId: true,
  invitedEmail: true,
  roleType: true,
  invitedById: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  acceptedAt: true,
  rejectedAt: true,
} satisfies Prisma.StaffInvitationSelect;

/** A pending row as the team's staff screen lists it (head coaches only). */
export const STAFF_INVITATION_LIST_SELECT = {
  ...STAFF_INVITATION_SELECT,
  // Name and tombstone signal only; the inviter is staff, but no email is needed here.
  invitedBy: { select: { id: true, name: true, deletedAt: true } },
} satisfies Prisma.StaffInvitationSelect;

/** What the invitee may see of an invitation addressed to them (public view and their own list). */
const PUBLIC_STAFF_INVITATION_SELECT = {
  id: true,
  status: true,
  roleType: true,
  expiresAt: true,
  team: { select: { name: true } },
  // Public payload: name and the tombstone signal only, never email.
  invitedBy: { select: { name: true, deletedAt: true } },
} satisfies Prisma.StaffInvitationSelect;

export type StaffInvitationSummary = Prisma.StaffInvitationGetPayload<{
  select: typeof STAFF_INVITATION_SELECT;
}>;
export type StaffInvitationListItem = Prisma.StaffInvitationGetPayload<{
  select: typeof STAFF_INVITATION_LIST_SELECT;
}>;
type PublicStaffInvitationRow = Prisma.StaffInvitationGetPayload<{
  select: typeof PUBLIC_STAFF_INVITATION_SELECT;
}>;
type StaffInvitationRow = StaffInvitationSummary;

export interface InviteStaffInput {
  email: string;
  roleType: StaffRoleType;
  /** Resend: expire the live PENDING row for this team + address and create a fresh one (new token). */
  supersede?: boolean;
}

/** Limited view of a staff invitation: the public token lookup and the invitee's own list. */
export interface PublicStaffInvitation {
  kind: 'staff';
  id: string;
  status: StaffInvitationSummary['status'];
  teamName: string;
  roleType: TeamRoleType;
  inviterName: string;
  /** Tombstone signal for the sender (#813): clients label from this, never the name. */
  inviterDeletedAt: string | null;
  expiresAt: string;
}

export interface AcceptStaffInvitationResult {
  kind: 'staff';
  invitation: StaffInvitationSummary;
  staff: TeamStaffWithRelations;
  /**
   * True when the accepting account already held a staff row on the team. The
   * row is left as it was (never re-roled, so accepting can never demote the
   * last head coach), mirroring the player accept's `update: {}`.
   */
  alreadyStaff: boolean;
}

function toPublic(row: PublicStaffInvitationRow): PublicStaffInvitation {
  return {
    kind: 'staff',
    id: row.id,
    status: row.status,
    teamName: row.team.name,
    roleType: row.roleType,
    inviterName: row.invitedBy.name,
    inviterDeletedAt: row.invitedBy.deletedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** The per-row address that replaces `invitedEmail` when it is stripped (same shape as guardian D17). */
export function strippedStaffInvitationEmail(invitationId: string): string {
  return `deleted-${invitationId}@invalid`;
}

export class StaffInvitationService {
  private static generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Invite an address to a staff role on a team. Gate: `canManageStaff`, the
   * same predicate as adding staff directly (head coach, league admin, system
   * admin; assistant coaches get 403). Creates no `User` row.
   *
   * Refused before anything is written: team 404, 403, role 404 (the team has
   * no default role of that type), 400 when the address already belongs to a
   * staff member of the team. Inside one transaction behind the team row lock
   * (the lock every staff mutation takes, so two invites for one address
   * serialise): a live PENDING row answers 400 unless `supersede`; the resend
   * cooldown (any status, keyed on the address hash) answers 429; lapsed rows
   * (and, with `supersede`, the live one) are expired; the new row is created.
   */
  static async inviteStaff(
    teamId: string,
    data: InviteStaffInput,
    userId: string
  ): Promise<StaffInvitationSummary & { emailSent: boolean }> {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, name: true } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (!(await canManageStaff(userId, teamId))) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }

    const role = await TeamService.findRoleByType(teamId, data.roleType);
    const email = data.email.trim().toLowerCase();
    const recipientHash = hashRecipient(email);

    const existingAccount = await prisma.user.findFirst({
      where: { email: emailEquals(email), deletedAt: null },
      select: { id: true },
    });
    if (existingAccount) {
      const staffRow = await prisma.teamStaff.findUnique({
        where: { teamId_userId: { teamId, userId: existingAccount.id } },
        select: { id: true },
      });
      if (staffRow) {
        throw new BadRequestError(ALREADY_STAFF);
      }
    }

    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + STAFF_INVITE_EXPIRES_DAYS);

    const { invitation, expiredCount } = await createOrConflict(
      () =>
        prisma.$transaction(async (tx) => {
          if (!(await lockTeamRow(tx, teamId))) {
            throw new NotFoundError('Team not found');
          }

          const now = new Date();
          const live = await tx.staffInvitation.findFirst({
            where: { teamId, invitedEmail: emailEquals(email), status: 'PENDING', expiresAt: { gt: now } },
            select: { id: true },
          });
          if (live && !data.supersede) {
            throw new BadRequestError(PENDING_STAFF_CONFLICT);
          }

          const latest = await tx.staffInvitation.findFirst({
            where: { teamId, recipientHash },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          assertResendCooldown(latest?.createdAt, 'address', {
            onRefused: (retryAfterSeconds) =>
              logger.info('Staff invitation resend refused (cooldown)', { teamId, invitedById: userId, retryAfterSeconds }),
          });

          // Lazy expiry: a lapsed PENDING row never blocks; with supersede the
          // live one is expired too, so the old link dies.
          const { count } = await tx.staffInvitation.updateMany({
            where: {
              teamId,
              invitedEmail: emailEquals(email),
              status: 'PENDING',
              ...(data.supersede ? {} : { expiresAt: { lte: now } }),
            },
            data: { status: 'EXPIRED' },
          });

          const created = await tx.staffInvitation.create({
            data: {
              token,
              teamId,
              invitedEmail: email,
              recipientHash,
              roleType: role.type,
              invitedById: userId,
              expiresAt,
              status: 'PENDING',
            },
            select: STAFF_INVITATION_SELECT,
          });
          return { invitation: created, expiredCount: count };
        }),
      PENDING_STAFF_CONFLICT,
      PENDING_STAFF_INDEX
    );

    // Read only once the row is committed: a refused request never pays for it.
    const inviter = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

    let emailSent: boolean;
    try {
      await withTimeout(
        mailer.send({
          template: staffInvitationTemplate,
          to: email,
          variables: {
            teamName: team.name,
            roleName: role.name,
            inviterName: inviter?.name ?? '',
            expiresAt: formatEmailDate(invitation.expiresAt),
            acceptUrl: `${publicAppUrl()}/invite/${token}`,
          },
          metadata: {
            event_type: 'staff_invitation.created',
            teamId,
            invitationId: invitation.id,
          },
        }),
        EMAIL_SEND_TIMEOUT_MS,
        'staff invitation email send'
      );
      emailSent = true;
    } catch (err: unknown) {
      logger.error('Failed to send staff invitation email', {
        error: err instanceof Error ? err.message : String(err),
        invitationId: invitation.id,
      });
      emailSent = false;
    }

    logger.info('Staff invitation sent', {
      invitationId: invitation.id,
      teamId,
      roleType: invitation.roleType,
      invitedById: userId,
      supersede: !!data.supersede,
      expiredCount,
      emailSent,
    });

    return { ...invitation, emailSent };
  }

  /** Pending, unexpired staff invitations of a team, for callers who may manage its staff. */
  static async listPendingForTeam(teamId: string, userId: string): Promise<StaffInvitationListItem[]> {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    if (!(await canManageStaff(userId, teamId))) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }
    return prisma.staffInvitation.findMany({
      where: { teamId, status: 'PENDING', expiresAt: { gt: new Date() } },
      select: STAFF_INVITATION_LIST_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Cancel a PENDING staff invitation (`canManageStaff` on its team). The
   * address is kept: like the player flow, only the invitee's own decline
   * strips it.
   */
  static async cancelInvitation(
    teamId: string,
    invitationId: string,
    userId: string
  ): Promise<StaffInvitationSummary> {
    const invitation = await prisma.staffInvitation.findFirst({
      where: { id: invitationId, teamId },
      select: { id: true, status: true },
    });
    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }
    if (!(await canManageStaff(userId, teamId))) {
      throw new ForbiddenError('You do not have permission to manage team staff');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot cancel invitation with status: ${invitation.status}`);
    }

    const cancelled = await orNotFound(
      () =>
        prisma.staffInvitation.update({
          where: { id: invitationId, status: 'PENDING' },
          data: { status: 'CANCELLED' },
          select: STAFF_INVITATION_SELECT,
        }),
      new BadRequestError('Cannot cancel invitation: it is no longer pending')
    );

    logger.info('Staff invitation cancelled', { invitationId, teamId, userId });
    return cancelled;
  }

  /**
   * Pending, unexpired staff invitations addressed to the signed-in account
   * (matched on its email with `emailEquals`). Rides on `GET /invitations` as
   * `staffInvitations`. Never includes the token.
   */
  static async listPendingForUser(userId: string): Promise<PublicStaffInvitation[]> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) {
      return [];
    }
    const rows = await prisma.staffInvitation.findMany({
      where: { invitedEmail: emailEquals(user.email), status: 'PENDING', expiresAt: { gt: new Date() } },
      select: PUBLIC_STAFF_INVITATION_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPublic);
  }

  /** Public, unauthenticated view (web invite page, app deep link). */
  static async getInvitationByToken(token: string): Promise<PublicStaffInvitation> {
    const row = await prisma.staffInvitation.findUnique({
      where: { token },
      select: PUBLIC_STAFF_INVITATION_SELECT,
    });
    if (!row) {
      throw new NotFoundError('Invitation not found');
    }
    return toPublic(row);
  }

  /**
   * Accept by token (unauthenticated; the token is the secret that was mailed
   * to the address). The staff row lands on the account that holds the
   * address, created here when there is none.
   */
  static async acceptInvitationByToken(token: string): Promise<AcceptStaffInvitationResult> {
    const invitation = await prisma.staffInvitation.findUnique({
      where: { token },
      select: STAFF_INVITATION_SELECT,
    });
    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }
    return this.accept(invitation);
  }

  /**
   * The staff invitation with this id when it is addressed to the caller;
   * `null` when no staff invitation has the id (the route then tries the
   * team invitation kind); 403 when it exists but was sent to another address.
   *
   * A row whose address was stripped (declined, or scrubbed by account
   * deletion) is no longer PENDING and carries no address to compare: nobody
   * can act on it, so it is returned and the status check answers 400 rather
   * than telling the invitee's own retry "not sent to you".
   */
  static async findInvitationForUser(invitationId: string, userId: string): Promise<StaffInvitationRow | null> {
    const invitation = await prisma.staffInvitation.findUnique({
      where: { id: invitationId },
      select: STAFF_INVITATION_SELECT,
    });
    if (!invitation) {
      return null;
    }
    if (invitation.status !== 'PENDING' && invitation.invitedEmail === strippedStaffInvitationEmail(invitation.id)) {
      return invitation;
    }
    const caller = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!isSameEmail(caller?.email, invitation.invitedEmail)) {
      throw new ForbiddenError('This invitation was not sent to you');
    }
    return invitation;
  }

  /**
   * Authenticated accept: the verified caller, never a second lookup by
   * address, takes the role. `found` is the row `findInvitationForUser`
   * already returned for this caller (the route's dispatch), saving a re-read.
   */
  static async acceptInvitation(
    invitationId: string,
    userId: string,
    found?: StaffInvitationRow
  ): Promise<AcceptStaffInvitationResult> {
    const invitation = found ?? (await this.requireInvitedUser(invitationId, userId));
    return this.accept(invitation, userId);
  }

  /**
   * The invitee declines. One conditional update (a row no longer PENDING
   * matches nothing, P2025 → 400), which also strips the address: the
   * rejection-only strip of the player flow. Only the hash stays, for the
   * resend cooldown. A coach's cancel and expiry keep the address.
   */
  static async rejectInvitation(
    invitationId: string,
    userId: string,
    found?: StaffInvitationRow
  ): Promise<StaffInvitationSummary> {
    const invitation = found ?? (await this.requireInvitedUser(invitationId, userId));
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot reject invitation with status: ${invitation.status}`);
    }

    const rejected = await orNotFound(
      () =>
        prisma.staffInvitation.update({
          where: { id: invitation.id, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            invitedEmail: strippedStaffInvitationEmail(invitation.id),
          },
          select: STAFF_INVITATION_SELECT,
        }),
      new BadRequestError('Cannot reject invitation: it is no longer pending')
    );

    logger.info('Staff invitation declined', { invitationId: invitation.id, teamId: invitation.teamId, userId });
    return rejected;
  }

  private static async requireInvitedUser(invitationId: string, userId: string): Promise<StaffInvitationRow> {
    const invitation = await this.findInvitationForUser(invitationId, userId);
    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }
    return invitation;
  }

  /**
   * The account the staff row lands on, inside the accept transaction (so a
   * refused or failed accept never leaves an account behind).
   *
   * Authenticated: the verified caller. By token: the live account holding
   * the address (`emailEquals`), else a new one (the address is the
   * invitee's: they hold the mailed link). The create is a native
   * `INSERT … ON CONFLICT ("email") DO NOTHING` followed by the same lookup,
   * so two concurrent accepts converge on one row instead of one aborting the
   * transaction with P2002. A new account is not managed, unverified, named
   * with the email local part (the placeholder the app's one-time name prompt
   * replaces), `ageConfirmedAt` null (the age screen runs at its first
   * sign-in), and COACH for a coaching role, PLAYER (the default, so the
   * app's role step asks) for a team manager.
   *
   * Refused by token (409 `sign_in_required`): an UNCLAIMED MANAGED roster
   * record holding the address. Its managing coach may still rewrite that
   * email (PATCH /players/:id, B2.10), so a staff role on it would be a grant
   * the coach could take by pointing the row at their own address and signing
   * in. The invitee signs in with the address instead, which claims the row,
   * and accepts in the app.
   */
  private static async resolveAcceptingUser(
    tx: Prisma.TransactionClient,
    invitation: Pick<StaffInvitationRow, 'invitedEmail' | 'roleType'>,
    verifiedUserId: string | undefined
  ): Promise<{ id: string; created: boolean }> {
    if (verifiedUserId) {
      return { id: verifiedUserId, created: false };
    }

    const byEmail = (): Promise<{ id: string; workosUserId: string | null; isManaged: boolean } | null> =>
      tx.user.findFirst({
        where: { email: emailEquals(invitation.invitedEmail), deletedAt: null },
        select: { id: true, workosUserId: true, isManaged: true },
      });

    let row = await byEmail();
    let created = false;
    if (!row) {
      const role: UserRole = invitation.roleType === 'TEAM_MANAGER' ? 'PLAYER' : 'COACH';
      const inserted = await tx.$executeRaw`
        INSERT INTO "User" ("id", "name", "email", "role", "emailVerified", "updatedAt")
        VALUES (${randomUUID()}, ${invitation.invitedEmail.split('@')[0]}, ${invitation.invitedEmail},
                ${role}::"UserRole", false, NOW())
        ON CONFLICT ("email") DO NOTHING`;
      created = inserted === 1;
      row = await byEmail();
      if (!row) {
        throw new Error('Staff invitation accept: the account for the invited address could not be read back');
      }
    }

    if (row.workosUserId === null && row.isManaged) {
      throw new SignInRequiredError();
    }
    return { id: row.id, created };
  }

  /**
   * Shared accept, one transaction (wrapped so a P2002 on the staff unique,
   * from a concurrent direct `POST /staff` that takes no team lock, answers
   * 400 rather than 500; nothing is written and a retry sees the row):
   *  - resolve or create the account (above);
   *  - lock the account's `User` row, then the `Team` row: account deletion
   *    takes the user first and its teams after, so the order agrees, and a
   *    tombstone never gets a staff row (404); every staff removal and re-role
   *    holds the team lock, so the accept serialises with them;
   *  - re-check that the INVITER may still manage this team's staff
   *    (`canManageStaff`, behind the lock): a coach removed, demoted or
   *    deleted after sending cannot come back through an invitation sent to
   *    an address they control. Their pending invitations die with the right;
   *  - flip PENDING → ACCEPTED guarded on the status (a lost race is 400);
   *  - create the staff row with the invited role unless the account already
   *    holds one, which is left unchanged (accepting never re-roles, so it can
   *    never demote the last head coach).
   */
  private static async accept(
    invitation: StaffInvitationRow,
    verifiedUserId?: string
  ): Promise<AcceptStaffInvitationResult> {
    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestError('This invitation has already been accepted');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot accept invitation with status: ${invitation.status}`);
    }
    if (new Date() > invitation.expiresAt) {
      await prisma.staffInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestError('This invitation has expired');
    }

    const roleType = invitation.roleType as StaffRoleType;

    const { result, account } = await createOrConflict(
      () =>
        prisma.$transaction(async (tx) => {
          const account = await this.resolveAcceptingUser(tx, invitation, verifiedUserId);
          const [locked] = await lockUsers(tx, [account.id]);
          if (!locked || locked.deletedAt !== null) {
            throw new NotFoundError('Account not found');
          }
          if (!(await lockTeamRow(tx, invitation.teamId))) {
            throw new NotFoundError('Team not found');
          }
          if (!(await canManageStaff(invitation.invitedById, invitation.teamId, tx))) {
            throw new BadRequestError(INVITER_LOST_RIGHT);
          }

          const { count } = await tx.staffInvitation.updateMany({
            where: { id: invitation.id, status: 'PENDING' },
            data: { status: 'ACCEPTED', acceptedAt: new Date() },
          });
          if (count === 0) {
            throw new BadRequestError('Cannot accept invitation: it is no longer pending');
          }

          const existing = await tx.teamStaff.findUnique({
            where: { teamId_userId: { teamId: invitation.teamId, userId: account.id } },
            include: TEAM_STAFF_INCLUDE,
          });
          let staff: TeamStaffWithRelations;
          if (existing) {
            staff = existing;
          } else {
            const role = await TeamService.findRoleByType(invitation.teamId, roleType, tx);
            staff = await tx.teamStaff.create({
              data: { teamId: invitation.teamId, userId: account.id, roleId: role.id },
              include: TEAM_STAFF_INCLUDE,
            });
          }

          const updated = await tx.staffInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
            select: STAFF_INVITATION_SELECT,
          });

          return {
            account,
            result: { kind: 'staff' as const, invitation: updated, staff, alreadyStaff: !!existing },
          };
        }),
      ALREADY_STAFF,
      'TeamStaff_teamId_userId_key'
    );

    // After COMMIT: a rolled-back accept must not log a role that never landed.
    logger.info('Staff invitation accepted', {
      invitationId: invitation.id,
      teamId: invitation.teamId,
      staffUserId: account.id,
      roleType: result.staff.role.type,
      alreadyStaff: result.alreadyStaff,
      accountCreated: account.created,
      via: verifiedUserId ? 'app' : 'token',
    });

    return result;
  }
}
