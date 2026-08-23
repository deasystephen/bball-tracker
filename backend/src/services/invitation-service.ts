/**
 * Invitation service layer for business logic
 */

import { Prisma, TeamInvitation, TeamMember } from '@prisma/client';
import prisma from '../models';
import {
  CreateInvitationInput,
  InvitationQueryParams,
} from '../api/invitations/schemas';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
} from '../utils/errors';
import { randomBytes } from 'crypto';
import { hasTeamPermission, canAccessTeam, isSystemAdmin, getPlayerTeamAccess } from '../utils/permissions';
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
   * Create a new team invitation
   * @param teamId Team ID
   * @param data Invitation data
   * @param userId User ID (must have canManageRoster permission)
   */
  static async createInvitation(
    teamId: string,
    data: CreateInvitationInput,
    userId: string
  ): Promise<InvitationWithRelations> {
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

      await this.assertInvitable(teamId, player.id);

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
      const email = data.email as string;
      const name = data.name as string;

      const existingUser = await prisma.user.findUnique({ where: { email } });

      if (existingUser) {
        await this.assertInvitable(teamId, existingUser.id);

        invitation = await prisma.teamInvitation.create({
          data: invitationData(existingUser.id),
          select: INVITATION_SELECT,
        });
      } else {
        invitation = await prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: {
              name,
              email,
              role: 'PLAYER',
              emailVerified: false,
              profilePictureUrl: data.profilePictureUrl,
            },
            select: { id: true },
          });

          return tx.teamInvitation.create({
            data: invitationData(created.id),
            select: INVITATION_SELECT,
          });
        });
      }
    }

    // Send invitation email (fire-and-forget; never block the response)
    if (invitation.player.email) {
      const baseUrl = process.env.PUBLIC_APP_URL || 'https://capyhoops.com';
      const acceptUrl = `${baseUrl}/invite/${token}`;
      mailer
        .send({
          template: invitationTemplate,
          to: invitation.player.email,
          variables: {
            playerName: invitation.player.name ?? invitation.player.email,
            teamName: invitation.team.name,
            inviterName: invitation.invitedBy.name ?? invitation.invitedBy.email ?? '',
            message: invitation.message ?? '',
            expiresAt: formatEmailDate(invitation.expiresAt),
            acceptUrl,
          },
          metadata: {
            userId: invitation.playerId,
            event_type: 'invitation.created',
            teamId: invitation.teamId,
            invitationId: invitation.id,
          },
        })
        .catch((err: unknown) => {
          logger.error('Failed to send invitation email', {
            error: err instanceof Error ? err.message : String(err),
            invitationId: invitation.id,
          });
        });
    }

    return invitation;
  }

  /**
   * Reject when the player is already rostered or already has a live PENDING
   * invitation. A PENDING row whose expiresAt has passed is not a blocker:
   * mark it EXPIRED and carry on (audit #23 — nothing else ever flips expired
   * rows, so dedupe must).
   */
  private static async assertInvitable(teamId: string, playerId: string): Promise<void> {
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

    const existingInvitation = await prisma.teamInvitation.findFirst({
      where: {
        teamId,
        playerId,
        status: 'PENDING',
      },
    });

    if (existingInvitation) {
      if (existingInvitation.expiresAt.getTime() > Date.now()) {
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
      // Another player's invitations are visible to system ADMINs, to roster
      // managers of the requested team, or — with no teamId — to roster
      // managers of a team that player is on, scoped to those teams. The
      // self-selected global COACH role used to be enough, which let any
      // user enumerate anyone's invitations (role matrix B2.4).
      if (playerId !== userId && !(await isSystemAdmin(userId))) {
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
      // If no playerId specified, default to current user's invitations
      where.playerId = userId;
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

    // Verify user is the invited player
    if (invitation.playerId !== userId) {
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

    // Check if player is already on the team
    const existingMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
        },
      },
    });

    if (existingMember) {
      throw new BadRequestError('You are already on this team');
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

      // Add player to team
      const teamMember = await tx.teamMember.create({
        data: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
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

    // Verify user is the invited player
    if (invitation.playerId !== userId) {
      throw new ForbiddenError('You can only reject your own invitations');
    }

    // Check invitation status
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot reject invitation with status: ${invitation.status}`
      );
    }

    // Update invitation status
    const updatedInvitation = await prisma.teamInvitation.update({
      where: { id: invitationId },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
      },
      select: INVITATION_TEAM_SELECT,
    });

    return updatedInvitation;
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

    // Check invitation status
    if (invitation.status !== 'PENDING') {
      throw new BadRequestError(
        `Cannot cancel invitation with status: ${invitation.status}`
      );
    }

    // Update invitation status
    const updatedInvitation = await prisma.teamInvitation.update({
      where: { id: invitationId },
      data: {
        status: 'CANCELLED',
      },
      select: INVITATION_SCALAR_SELECT,
    });

    return updatedInvitation;
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

    const existingMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
        },
      },
    });

    if (existingMember) {
      throw new BadRequestError('You are already on this team');
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedInvitation = await this.transitionPending(
        tx,
        invitation.id,
        { status: 'ACCEPTED', acceptedAt: new Date() },
        'accept'
      );

      const teamMember = await tx.teamMember.create({
        data: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
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
