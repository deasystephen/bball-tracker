/**
 * Invitation service layer for business logic
 */

import { Prisma, TeamInvitation, TeamMember } from '@prisma/client';
import prisma from '../models';
import {
  CreateInvitationInput,
  InvitationQueryParams,
} from '../api/invitations/schemas';
import { AddRosterPlayerInput } from '../api/teams/schemas';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
} from '../utils/errors';
import { randomBytes } from 'crypto';
import {
  hasTeamPermission,
  canAccessTeam,
  isSystemAdmin,
  getPlayerTeamAccess,
  isGuardianOf,
} from '../utils/permissions';
import { GuardianService } from './guardian-service';
import { mailer } from './mailer';
import { invitationTemplate } from './mailer/templates';
import { logger } from '../utils/logger';
import { formatEmailDate } from '../utils/format-date';

const USER_SUMMARY_SELECT = {
  id: true,
  name: true,
  email: true,
} satisfies Prisma.UserSelect;

/**
 * Scalar fields safe to return on authenticated responses.
 *
 * `token` is deliberately absent: it is a bearer secret that lets anyone call
 * the unauthenticated `POST /invitations/by-token/:token/accept`, so it must
 * only ever travel inside the invitation email (audit #14).
 */
const INVITATION_SCALAR_SELECT = {
  id: true,
  teamId: true,
  playerId: true,
  invitedById: true,
  status: true,
  jerseyNumber: true,
  position: true,
  message: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  acceptedAt: true,
  rejectedAt: true,
} satisfies Prisma.TeamInvitationSelect;

const INVITATION_SELECT = {
  ...INVITATION_SCALAR_SELECT,
  team: {
    select: {
      id: true,
      name: true,
      season: {
        select: {
          id: true,
          name: true,
          league: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  },
  player: { select: USER_SUMMARY_SELECT },
  invitedBy: { select: USER_SUMMARY_SELECT },
} satisfies Prisma.TeamInvitationSelect;

const INVITATION_TEAM_SELECT = {
  ...INVITATION_SCALAR_SELECT,
  team: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.TeamInvitationSelect;

const ACCEPTED_MEMBER_INCLUDE = {
  player: { select: USER_SUMMARY_SELECT },
  team: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.TeamMemberInclude;

/** Invitation without its secret `token` (every authenticated response). */
export type InvitationSummary = Prisma.TeamInvitationGetPayload<{
  select: typeof INVITATION_SCALAR_SELECT;
}>;
export type InvitationWithRelations = Prisma.TeamInvitationGetPayload<{
  select: typeof INVITATION_SELECT;
}>;
export type InvitationWithTeam = Prisma.TeamInvitationGetPayload<{
  select: typeof INVITATION_TEAM_SELECT;
}>;
export type AcceptedTeamMember = Prisma.TeamMemberGetPayload<{
  include: typeof ACCEPTED_MEMBER_INCLUDE;
}>;

export interface InvitationList {
  invitations: InvitationWithRelations[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface AcceptInvitationResult {
  invitation: InvitationSummary;
  teamMember: AcceptedTeamMember;
}

/**
 * `createInvitation` result. `emailSent` is `null` when the invited player has
 * no email address; otherwise it reports whether the invitation email was
 * handed to the mailer successfully (roster/invite unification spec — a
 * silently failed send was invisible to coaches, SES-sandbox incident
 * 2026-08-28).
 */
export interface CreateInvitationResult {
  invitation: InvitationWithRelations;
  emailSent: boolean | null;
}

const ADDED_MEMBER_INCLUDE = {
  player: {
    select: {
      ...USER_SUMMARY_SELECT,
      isManaged: true,
      managedById: true,
    },
  },
  team: { select: { id: true, name: true } },
} satisfies Prisma.TeamMemberInclude;

export type AddedTeamMember = Prisma.TeamMemberGetPayload<{
  include: typeof ADDED_MEMBER_INCLUDE;
}>;

/**
 * `POST /teams/:teamId/players` (unified Add Player) result.
 *
 * - Cases 1-2 (no email / email without a claimed account): `rostered: true`,
 *   `member` set; case 2 also has `invitation` + `emails.player`.
 * - Case 3 (email belongs to a claimed account): `rostered: false`,
 *   `invitation` set — membership is created when the player accepts (consent
 *   model; auto-accept is deferred, decision D2).
 * - `guardianInvited` is true only when a `GuardianInvitation` was created
 *   (requires a roster entry, so never in case 3 — `guardianReason` explains).
 */
export interface AddRosterPlayerResult {
  rostered: boolean;
  invited: boolean;
  member: AddedTeamMember | null;
  invitation: InvitationSummary | null;
  guardianInvited: boolean;
  guardianReason?: string;
  emails: { player?: boolean; guardian?: boolean };
}

export interface AcceptInvitationByTokenResult {
  invitation: InvitationSummary;
  teamMember: TeamMember;
}

/** Limited, unauthenticated view of an invitation (public token lookup). */
export interface PublicInvitation {
  id: string;
  status: TeamInvitation['status'];
  teamName: string;
  inviterName: string;
  position: string | null;
  jerseyNumber: number | null;
  message: string | null;
  expiresAt: string;
}

export class InvitationService {
  /**
   * Generate a secure invitation token
   */
  private static generateToken(): string {
    // Generate 32-byte random token and convert to base64url
    return randomBytes(32).toString('base64url');
  }

  /**
   * Create a new team invitation.
   *
   * With `data.supersede` a live PENDING invitation for the player is expired
   * and replaced instead of answering 400 — this is how "Resend" works
   * (roster/invite unification spec: one write path for invitation birth, the
   * old link dies because the token is new).
   *
   * @param teamId Team ID
   * @param data Invitation data
   * @param userId User ID (must have canManageRoster permission)
   */
  static async createInvitation(
    teamId: string,
    data: CreateInvitationInput,
    userId: string
  ): Promise<CreateInvitationResult> {
    // Get team
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to send invitations for this team');
    }

    // Calculate expiration date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays || 7));

    // Generate secure token
    const token = this.generateToken();

    const invitationData = (playerId: string): Prisma.TeamInvitationUncheckedCreateInput => ({
      teamId,
      playerId,
      invitedById: userId,
      token,
      jerseyNumber: data.jerseyNumber,
      position: data.position,
      message: data.message,
      expiresAt,
      status: 'PENDING',
    });

    let invitation: InvitationWithRelations;

    if (data.playerId) {
      // Invite an existing user
      const player = await prisma.user.findUnique({
        where: { id: data.playerId },
      });

      if (!player) {
        throw new NotFoundError('User not found');
      }

      // Supersede ("Resend"/"Invite" from the roster) legitimately targets a
      // player who is already a member — an invited-at-creation managed player
      // (case 2). A member whose account is claimed is already Active; a new
      // invitation would be meaningless.
      if (data.supersede) {
        await this.assertNotActiveMember(teamId, player.id, player.workosUserId);
      }

      await this.assertInvitable(teamId, player.id, {
        supersede: data.supersede,
        allowExistingMember: data.supersede,
      });

      invitation = await prisma.teamInvitation.create({
        data: invitationData(player.id),
        select: INVITATION_SELECT,
      });
    } else {
      // Create-and-invite (audit #69). `name` + `email` are guaranteed by the
      // schema. If the email already belongs to a user (e.g. a retry after a
      // partial failure, or a player who signed up on their own) reuse that
      // account instead of failing; otherwise create the user and the
      // invitation in ONE transaction so a failed invite leaves no orphan.
      // Two coaches racing the same new email both pass the findUnique — the
      // loser's create hits P2002 and retries once against the now-existing
      // row instead of surfacing a 500.
      const email = data.email as string;
      const name = data.name as string;

      const existingUser = await prisma.user.findUnique({ where: { email } });

      if (existingUser) {
        if (data.supersede) {
          await this.assertNotActiveMember(teamId, existingUser.id, existingUser.workosUserId);
        }
        await this.assertInvitable(teamId, existingUser.id, {
          supersede: data.supersede,
          allowExistingMember: data.supersede,
        });

        invitation = await prisma.teamInvitation.create({
          data: invitationData(existingUser.id),
          select: INVITATION_SELECT,
        });
      } else {
        try {
          invitation = await prisma.$transaction(async (tx) => {
            const created = await tx.user.create({
              data: {
                name,
                email,
                role: 'PLAYER',
                emailVerified: false,
                profilePictureUrl: data.profilePictureUrl,
                // The creating coach manages this account until it is claimed
                // (chip derivation + B2.10 edit rights; unification spec T2).
                isManaged: true,
                managedById: userId,
              },
              select: { id: true },
            });

            return tx.teamInvitation.create({
              data: invitationData(created.id),
              select: INVITATION_SELECT,
            });
          });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
            throw err;
          }
          const racedUser = await prisma.user.findUnique({ where: { email } });
          if (!racedUser) {
            throw err;
          }
          await this.assertInvitable(teamId, racedUser.id, { supersede: data.supersede });
          invitation = await prisma.teamInvitation.create({
            data: invitationData(racedUser.id),
            select: INVITATION_SELECT,
          });
        }
      }
    }

    const emailSent = await this.deliverInvitationEmail(invitation, token, 'invited');

    return { invitation, emailSent };
  }

  /**
   * Send the invitation email and report success. Failures are logged and
   * returned as `false`, never thrown — the invitation row is already
   * committed and usable in-app. Returns `null` when the player has no email.
   */
  private static async deliverInvitationEmail(
    invitation: InvitationWithRelations,
    token: string,
    variant: 'invited' | 'added'
  ): Promise<boolean | null> {
    if (!invitation.player.email) {
      return null;
    }

    const baseUrl = process.env.PUBLIC_APP_URL || 'https://capyhoops.com';
    const acceptUrl = `${baseUrl}/invite/${token}`;
    try {
      await mailer.send({
        template: invitationTemplate,
        to: invitation.player.email,
        variables: {
          playerName: invitation.player.name ?? invitation.player.email,
          teamName: invitation.team.name,
          inviterName: invitation.invitedBy.name ?? invitation.invitedBy.email ?? '',
          message: invitation.message ?? '',
          expiresAt: formatEmailDate(invitation.expiresAt),
          acceptUrl,
          variant,
        },
        metadata: {
          userId: invitation.playerId,
          event_type: 'invitation.created',
          teamId: invitation.teamId,
          invitationId: invitation.id,
        },
      });
      return true;
    } catch (err: unknown) {
      logger.error('Failed to send invitation email', {
        error: err instanceof Error ? err.message : String(err),
        invitationId: invitation.id,
      });
      return false;
    }
  }

  /**
   * A claimed account that is already a member is Active — inviting it again
   * (supersede path) is a coach mistake, not a resend.
   */
  private static async assertNotActiveMember(
    teamId: string,
    playerId: string,
    workosUserId: string | null
  ): Promise<void> {
    if (!workosUserId) {
      return;
    }
    const member = await prisma.teamMember.findUnique({
      where: { teamId_playerId: { teamId, playerId } },
    });
    if (member) {
      throw new BadRequestError('Player already has access to this team');
    }
  }

  /**
   * Reject when the player is already rostered or already has a live PENDING
   * invitation. A PENDING row whose expiresAt has passed is not a blocker:
   * mark it EXPIRED and carry on (audit #23 — nothing else ever flips expired
   * rows, so dedupe must).
   *
   * Options:
   * - `supersede`: a live PENDING invitation is expired instead of throwing —
   *   the "Resend" path (unification spec D4-as-amended).
   * - `allowExistingMember`: skip the roster check — the unified Add Player
   *   flow creates the membership and the invitation together, so the member
   *   row legitimately exists (or is about to).
   */
  private static async assertInvitable(
    teamId: string,
    playerId: string,
    options: { supersede?: boolean; allowExistingMember?: boolean } = {}
  ): Promise<void> {
    if (!options.allowExistingMember) {
      const existingMember = await prisma.teamMember.findUnique({
        where: {
          teamId_playerId: {
            teamId,
            playerId,
          },
        },
      });

      if (existingMember) {
        throw new BadRequestError('Player is already on this team');
      }
    }

    const existingInvitation = await prisma.teamInvitation.findFirst({
      where: {
        teamId,
        playerId,
        status: 'PENDING',
      },
    });

    if (existingInvitation) {
      if (
        existingInvitation.expiresAt.getTime() > Date.now() &&
        !options.supersede
      ) {
        throw new BadRequestError('A pending invitation already exists for this player');
      }
      await this.markExpired(existingInvitation.id);
    }
  }

  /**
   * List invitations with optional filters
   * @param params Query parameters
   * @param userId User ID (for authorization)
   */
  static async listInvitations(
    params: InvitationQueryParams,
    userId: string
  ): Promise<InvitationList> {
    const { status, teamId, playerId, limit, offset } = params;

    // Build where clause
    const where: Prisma.TeamInvitationWhereInput = {};

    if (status) {
      where.status = status;
    }

    // Staff who can manage the roster see every invitation for the team
    // (pending, rejected, expired, ...). Anyone else with team access (a
    // rostered player) is scoped to their own rows, as before (audit #23).
    let scopeToCaller = true;

    if (teamId) {
      // Verify user has access to this team
      const hasAccess = await canAccessTeam(userId, teamId);
      if (!hasAccess) {
        throw new ForbiddenError('You do not have access to this team\'s invitations');
      }

      where.teamId = teamId;
      scopeToCaller = !(await hasTeamPermission(userId, teamId, 'canManageRoster'));
    }

    if (playerId) {
      // Another player's invitations are visible to system ADMINs, to the
      // player's guardians (PARENT role), to roster managers of the requested
      // team, or — with no teamId — to roster managers of a team that player
      // is on, scoped to those teams. The self-selected global COACH role used
      // to be enough, which let any user enumerate anyone's invitations (role
      // matrix B2.4).
      if (
        playerId !== userId &&
        !(await isSystemAdmin(userId)) &&
        !(await isGuardianOf(userId, playerId))
      ) {
        if (teamId) {
          if (scopeToCaller) {
            throw new ForbiddenError('You can only view your own invitations');
          }
        } else {
          const { manageableTeamIds } = await getPlayerTeamAccess(userId, playerId);
          if (manageableTeamIds.length === 0) {
            throw new ForbiddenError('You can only view your own invitations');
          }
          where.teamId = { in: manageableTeamIds };
        }
      }

      where.playerId = playerId;
    } else if (scopeToCaller) {
      // If no playerId specified, default to the caller's own invitations plus
      // those addressed to the caller's children (guardian).
      const childIds = await GuardianService.getChildIds(userId);
      where.playerId = childIds.length > 0 ? { in: [userId, ...childIds] } : userId;
    }

    // Get total count and invitations in parallel
    const [total, invitations] = await Promise.all([
      prisma.teamInvitation.count({ where }),
      prisma.teamInvitation.findMany({
        where,
        select: INVITATION_SELECT,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return {
      invitations,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };
  }

  /**
   * Get an invitation by ID
   * @param invitationId Invitation ID
   * @param userId User ID (for authorization)
   */
  static async getInvitationById(
    invitationId: string,
    userId: string
  ): Promise<InvitationWithRelations> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
      select: INVITATION_SELECT,
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user has access (team access or is the invited player)
    const hasAccess = await canAccessTeam(userId, invitation.teamId);
    const isPlayer = invitation.playerId === userId;

    if (!hasAccess && !isPlayer) {
      throw new ForbiddenError('You do not have access to this invitation');
    }

    return invitation;
  }

  /**
   * Accept an invitation
   * @param invitationId Invitation ID
   * @param userId User ID (must be the invited player)
   */
  static async acceptInvitation(
    invitationId: string,
    userId: string
  ): Promise<AcceptInvitationResult> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user is the invited player, or a guardian of the invited player
    if (invitation.playerId !== userId && !(await isGuardianOf(userId, invitation.playerId))) {
      throw new ForbiddenError('You can only accept your own invitations');
    }

    // Check invitation status
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot accept invitation with status: ${invitation.status}`
      );
    }

    // Check if invitation has expired
    if (new Date() > invitation.expiresAt) {
      await this.markExpired(invitationId);
      throw new BadRequestError('This invitation has expired');
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Flip PENDING -> ACCEPTED only if it is still PENDING. Two concurrent
      // accepts (double-tap, web + app) race here; the loser sees 0 rows and
      // gets a 400 instead of a P2002 500 from the TeamMember insert (audit #58).
      const updatedInvitation = await this.transitionPending(
        tx,
        invitationId,
        { status: 'ACCEPTED', acceptedAt: new Date() },
        'accept'
      );

      // Add player to team. Players added through the unified Add Player flow
      // (unification spec, case 2) are rostered at creation, so the membership
      // may already exist — accept then only flips the invitation; the
      // roster row (and any coach-set jersey/position) is left untouched.
      const teamMember = await tx.teamMember.upsert({
        where: {
          teamId_playerId: {
            teamId: invitation.teamId,
            playerId: invitation.playerId,
          },
        },
        create: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
        update: {},
        include: ACCEPTED_MEMBER_INCLUDE,
      });

      return { invitation: updatedInvitation, teamMember };
    });

    return result;
  }

  /**
   * Lazily mark a PENDING invitation EXPIRED. Status-guarded so a concurrent
   * accept/reject/cancel is never overwritten.
   */
  private static async markExpired(invitationId: string): Promise<void> {
    await prisma.teamInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  }

  /**
   * Move an invitation out of PENDING with a status predicate, returning the
   * updated row. Throws BadRequestError when the row is no longer PENDING —
   * i.e. another request won the race.
   */
  private static async transitionPending(
    tx: Prisma.TransactionClient,
    invitationId: string,
    data: Prisma.TeamInvitationUpdateManyMutationInput,
    action: 'accept' | 'reject' | 'cancel'
  ): Promise<InvitationSummary> {
    const { count } = await tx.teamInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data,
    });

    if (count === 0) {
      throw new BadRequestError(`Cannot ${action} invitation: it is no longer pending`);
    }

    return tx.teamInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: INVITATION_SCALAR_SELECT,
    });
  }

  /**
   * Consent guard (unification spec T1): a rejected/cancelled invitation must
   * not leave a claimable email behind. `syncUser` links ANY unclaimed row by
   * email on first WorkOS login (memberships kept, isManaged cleared), so an
   * email surviving rejection turns a later, unrelated sign-up into silent
   * team membership — auto-accept with extra steps. Strip the email while the
   * account is unclaimed, unless another live PENDING invitation still
   * references it (that team's invite email already points at this address).
   * The roster entry itself survives (decision D1) as a plain managed player.
   */
  private static async stripUnclaimedEmail(
    tx: Prisma.TransactionClient,
    playerId: string
  ): Promise<void> {
    const otherPending = await tx.teamInvitation.count({
      where: { playerId, status: 'PENDING' },
    });
    if (otherPending > 0) {
      return;
    }
    await tx.user.updateMany({
      where: { id: playerId, workosUserId: null },
      data: { email: null },
    });
  }

  /**
   * Reject an invitation
   * @param invitationId Invitation ID
   * @param userId User ID (must be the invited player)
   */
  static async rejectInvitation(invitationId: string, userId: string): Promise<InvitationWithTeam> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user is the invited player, or a guardian of the invited player
    if (invitation.playerId !== userId && !(await isGuardianOf(userId, invitation.playerId))) {
      throw new ForbiddenError('You can only reject your own invitations');
    }

    // Check invitation status (fast path; transitionPending re-checks under
    // the transaction so a racing accept can't be overwritten)
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot reject invitation with status: ${invitation.status}`
      );
    }

    return prisma.$transaction(async (tx) => {
      await this.transitionPending(
        tx,
        invitationId,
        { status: 'REJECTED', rejectedAt: new Date() },
        'reject'
      );

      await this.stripUnclaimedEmail(tx, invitation.playerId);

      return tx.teamInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: INVITATION_TEAM_SELECT,
      });
    });
  }

  /**
   * Cancel an invitation (must have canManageRoster permission)
   * @param invitationId Invitation ID
   * @param userId User ID
   */
  static async cancelInvitation(invitationId: string, userId: string): Promise<InvitationSummary> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Check permission
    const canManageRoster = await hasTeamPermission(userId, invitation.teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError('You do not have permission to cancel invitations for this team');
    }

    // Check invitation status (fast path; transitionPending re-checks under
    // the transaction so a racing accept can't be overwritten)
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot cancel invitation with status: ${invitation.status}`
      );
    }

    return prisma.$transaction(async (tx) => {
      const updated = await this.transitionPending(
        tx,
        invitationId,
        { status: 'CANCELLED' },
        'cancel'
      );

      await this.stripUnclaimedEmail(tx, invitation.playerId);

      return updated;
    });
  }

  /**
   * Unified Add Player — `POST /teams/:teamId/players` (roster/invite
   * unification spec, docs/plans/roster-invite-unification-spec.md).
   *
   * Consent model:
   *
   * ```
   * playerEmail?                              rows created (one transaction)
   * ── none ────────────────► case 1: managed User + TeamMember
   * ── no claimed account ──► case 2: managed User (reused if unclaimed row
   *                                   exists) + TeamMember + TeamInvitation
   * ── claimed account ─────► case 3: TeamInvitation only (membership on
   *                                   accept; pre-consent membership would be
   *                                   auto-accept, deferred by D2)
   * ```
   *
   * `guardianEmail` additionally invites a parent/guardian, but only when the
   * player got a roster entry (cases 1-2) — the guardian system requires
   * membership. In case 3 the response carries `guardianInvited: false` and a
   * reason instead of failing the whole add.
   */
  static async addRosterPlayer(
    teamId: string,
    data: AddRosterPlayerInput,
    userId: string
  ): Promise<AddRosterPlayerResult> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const canManageRoster = await hasTeamPermission(userId, teamId, 'canManageRoster');
    if (!canManageRoster) {
      throw new ForbiddenError("You do not have permission to manage this team's roster");
    }

    const result: AddRosterPlayerResult = {
      rostered: false,
      invited: false,
      member: null,
      invitation: null,
      guardianInvited: false,
      emails: {},
    };
    let playerId: string;

    if (!data.playerEmail) {
      // Case 1 — roster-only managed player (today's addManagedPlayer).
      result.member = await prisma.$transaction(async (tx) => {
        const managedUser = await tx.user.create({
          data: {
            name: data.name,
            role: 'PLAYER',
            isManaged: true,
            managedById: userId,
            email: null,
            profilePictureUrl: data.profilePictureUrl,
          },
          select: { id: true },
        });

        return tx.teamMember.create({
          data: {
            teamId,
            playerId: managedUser.id,
            jerseyNumber: data.jerseyNumber,
            position: data.position,
          },
          include: ADDED_MEMBER_INCLUDE,
        });
      });
      result.rostered = true;
      playerId = result.member.playerId;
    } else {
      const email = data.playerEmail;
      const existing = await prisma.user.findUnique({ where: { email } });

      if (existing?.workosUserId) {
        // Case 3 — claimed account: invitation only.
        const created = await this.createCase3Invitation(teamId, existing.id, data, userId);
        result.invitation = created.invitation;
        result.invited = true;
        result.emails.player = created.emailSent ?? undefined;
        playerId = existing.id;
      } else {
        // Case 2 — new email, or an unclaimed pre-provisioned row (the
        // "middle case"): managed player rostered immediately + invitation.
        // Two coaches racing the same new email both pass the findUnique;
        // the loser's user.create aborts the transaction with P2002 and we
        // retry once against the row that now exists.
        let created: { member: AddedTeamMember; invitation: InvitationWithRelations; token: string };
        try {
          created = await this.createRosteredInvitedPlayer(teamId, data, userId, existing);
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
            throw err;
          }
          const raced = await prisma.user.findUnique({ where: { email } });
          if (!raced) {
            throw err;
          }
          if (raced.workosUserId) {
            const case3 = await this.createCase3Invitation(teamId, raced.id, data, userId);
            result.invitation = case3.invitation;
            result.invited = true;
            result.emails.player = case3.emailSent ?? undefined;
            playerId = raced.id;
            return this.attachGuardianInvite(teamId, playerId, data, userId, result);
          }
          created = await this.createRosteredInvitedPlayer(teamId, data, userId, raced);
        }

        result.member = created.member;
        result.invitation = this.toSummary(created.invitation);
        result.rostered = true;
        result.invited = true;
        playerId = created.member.playerId;
        result.emails.player =
          (await this.deliverInvitationEmail(created.invitation, created.token, 'added')) ??
          undefined;
      }
    }

    return this.attachGuardianInvite(teamId, playerId, data, userId, result);
  }

  /** Case 3 helper: invitation for a claimed account, "invited" email copy. */
  private static async createCase3Invitation(
    teamId: string,
    playerId: string,
    data: AddRosterPlayerInput,
    userId: string
  ): Promise<{ invitation: InvitationSummary; emailSent: boolean | null }> {
    await this.assertInvitable(teamId, playerId);

    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await prisma.teamInvitation.create({
      data: {
        teamId,
        playerId,
        invitedById: userId,
        token,
        jerseyNumber: data.jerseyNumber,
        position: data.position,
        expiresAt,
        status: 'PENDING',
      },
      select: INVITATION_SELECT,
    });

    const emailSent = await this.deliverInvitationEmail(invitation, token, 'invited');
    return { invitation: this.toSummary(invitation), emailSent };
  }

  /**
   * Case 2 helper: managed user (created, or an unclaimed row reused — flags
   * set, `managedById` only when it was null, name/role never touched) +
   * membership + invitation, atomically. Any live PENDING invitation for the
   * pair is expired first (supersede semantics).
   */
  private static async createRosteredInvitedPlayer(
    teamId: string,
    data: AddRosterPlayerInput,
    userId: string,
    reuse: { id: string; managedById: string | null } | null
  ): Promise<{ member: AddedTeamMember; invitation: InvitationWithRelations; token: string }> {
    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    return prisma.$transaction(async (tx) => {
      let playerId: string;
      if (reuse) {
        await tx.user.update({
          where: { id: reuse.id },
          data: {
            isManaged: true,
            ...(reuse.managedById ? {} : { managedById: userId }),
          },
        });
        playerId = reuse.id;
      } else {
        const created = await tx.user.create({
          data: {
            name: data.name,
            email: data.playerEmail,
            role: 'PLAYER',
            emailVerified: false,
            isManaged: true,
            managedById: userId,
            profilePictureUrl: data.profilePictureUrl,
          },
          select: { id: true },
        });
        playerId = created.id;
      }

      const existingMember = await tx.teamMember.findUnique({
        where: { teamId_playerId: { teamId, playerId } },
      });
      if (existingMember) {
        throw new BadRequestError('Player is already on this team');
      }

      await tx.teamInvitation.updateMany({
        where: { teamId, playerId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });

      const member = await tx.teamMember.create({
        data: {
          teamId,
          playerId,
          jerseyNumber: data.jerseyNumber,
          position: data.position,
        },
        include: ADDED_MEMBER_INCLUDE,
      });

      const invitation = await tx.teamInvitation.create({
        data: {
          teamId,
          playerId,
          invitedById: userId,
          token,
          jerseyNumber: data.jerseyNumber,
          position: data.position,
          expiresAt,
          status: 'PENDING',
        },
        select: INVITATION_SELECT,
      });

      return { member, invitation, token };
    });
  }

  /** Strip relations down to the scalar summary (token was never selected). */
  private static toSummary(invitation: InvitationWithRelations | InvitationSummary): InvitationSummary {
    const {
      id, teamId, playerId, invitedById, status, jerseyNumber, position,
      message, expiresAt, createdAt, updatedAt, acceptedAt, rejectedAt,
    } = invitation;
    return {
      id, teamId, playerId, invitedById, status, jerseyNumber, position,
      message, expiresAt, createdAt, updatedAt, acceptedAt, rejectedAt,
    };
  }

  /** Guardian half of the unified Add Player (cases 1-2 only). */
  private static async attachGuardianInvite(
    teamId: string,
    playerId: string | null,
    data: AddRosterPlayerInput,
    userId: string,
    result: AddRosterPlayerResult
  ): Promise<AddRosterPlayerResult> {
    if (!data.guardianEmail || !data.guardianRelationship) {
      return result;
    }

    if (!result.rostered || !playerId) {
      result.guardianReason =
        'Guardians can be added after the player accepts the invitation and joins the roster';
      return result;
    }

    try {
      const guardian = await GuardianService.inviteGuardian(
        teamId,
        playerId,
        { email: data.guardianEmail, relationship: data.guardianRelationship },
        userId
      );
      result.guardianInvited = true;
      result.emails.guardian = guardian.emailSent ?? undefined;
    } catch (err) {
      // The player was already created and rostered — report the guardian
      // failure instead of failing the whole add.
      result.guardianReason =
        err instanceof Error ? err.message : 'Failed to invite guardian';
    }
    return result;
  }

  /**
   * Get an invitation by token (public, no user context required).
   * Returns a limited view safe to expose without authentication.
   */
  static async getInvitationByToken(token: string): Promise<PublicInvitation> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { token },
      select: {
        id: true,
        status: true,
        position: true,
        jerseyNumber: true,
        message: true,
        expiresAt: true,
        team: {
          select: { name: true },
        },
        invitedBy: {
          select: { name: true },
        },
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    return {
      id: invitation.id,
      status: invitation.status,
      teamName: invitation.team.name,
      inviterName: invitation.invitedBy.name,
      position: invitation.position,
      jerseyNumber: invitation.jerseyNumber,
      message: invitation.message,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Accept an invitation using its token as authentication.
   * The token functions as a one-time secret (analogous to a password-reset link).
   */
  static async acceptInvitationByToken(token: string): Promise<AcceptInvitationByTokenResult> {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { token },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestError('This invitation has already been accepted');
    }

    if (invitation.status === 'REJECTED') {
      throw new BadRequestError('This invitation has been rejected');
    }

    if (invitation.status === 'CANCELLED') {
      throw new BadRequestError('This invitation has been cancelled');
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(`Cannot accept invitation with status: ${invitation.status}`);
    }

    if (new Date() > invitation.expiresAt) {
      await this.markExpired(invitation.id);
      throw new BadRequestError('This invitation has expired');
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedInvitation = await this.transitionPending(
        tx,
        invitation.id,
        { status: 'ACCEPTED', acceptedAt: new Date() },
        'accept'
      );

      // Membership may already exist for players rostered at creation
      // (unification spec, case 2) — see acceptInvitation.
      const teamMember = await tx.teamMember.upsert({
        where: {
          teamId_playerId: {
            teamId: invitation.teamId,
            playerId: invitation.playerId,
          },
        },
        create: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
        update: {},
      });

      return { invitation: updatedInvitation, teamMember };
    });

    return result;
  }

  /**
   * Bulk-expire PENDING invitations past their expiresAt.
   *
   * Not scheduled anywhere today — expiry is applied lazily by
   * createInvitation (dedupe) and accept/acceptByToken (audit #23). Kept for a
   * future cron/maintenance job.
   */
  static async expireOldInvitations(): Promise<Prisma.BatchPayload> {
    const now = new Date();

    const result = await prisma.teamInvitation.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: {
          lt: now,
        },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    return result;
  }
}
