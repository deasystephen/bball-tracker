/**
 * Invitation service layer for business logic
 */

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
import { hasTeamPermission, canAccessTeam } from '../utils/permissions';
import { mailer } from './mailer';
import { invitationTemplate } from './mailer/templates';
import { logger } from '../utils/logger';

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
  ) {
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

    // Verify user exists
    const player = await prisma.user.findUnique({
      where: { id: data.playerId },
    });

    if (!player) {
      throw new NotFoundError('User not found');
    }

    // Check if player is already on the team
    const existingMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId,
          playerId: data.playerId,
        },
      },
    });

    if (existingMember) {
      throw new BadRequestError('Player is already on this team');
    }

    // Check if there's already a pending invitation
    const existingInvitation = await prisma.teamInvitation.findFirst({
      where: {
        teamId,
        playerId: data.playerId,
        status: 'PENDING',
      },
    });

    if (existingInvitation) {
      throw new BadRequestError('A pending invitation already exists for this player');
    }

    // Calculate expiration date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays || 7));

    // Generate secure token
    const token = this.generateToken();

    // Create invitation
    const invitation = await prisma.teamInvitation.create({
      data: {
        teamId,
        playerId: data.playerId,
        invitedById: userId,
        token,
        jerseyNumber: data.jerseyNumber,
        position: data.position,
        message: data.message,
        expiresAt,
        status: 'PENDING',
      },
      include: {
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
        player: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        invitedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Send invitation email (fire-and-forget; never block the response)
    if (invitation.player.email) {
      mailer
        .send({
          template: invitationTemplate,
          to: invitation.player.email,
          variables: {
            playerName: invitation.player.name ?? invitation.player.email,
            teamName: invitation.team.name,
            inviterName: invitation.invitedBy.name ?? invitation.invitedBy.email ?? '',
            message: invitation.message ?? '',
            expiresAt: invitation.expiresAt.toLocaleDateString(),
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
   * List invitations with optional filters
   * @param params Query parameters
   * @param userId User ID (for authorization)
   */
  static async listInvitations(params: InvitationQueryParams, userId: string) {
    const { status, teamId, playerId, limit, offset } = params;

    // Build where clause
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (teamId) {
      // Verify user has access to this team
      const hasAccess = await canAccessTeam(userId, teamId);
      if (!hasAccess) {
        throw new ForbiddenError('You do not have access to this team\'s invitations');
      }

      where.teamId = teamId;
    }

    if (playerId) {
      // Verify user is requesting their own invitations or has permission
      if (playerId !== userId) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
        });

        if (!user || user.role !== 'COACH') {
          throw new ForbiddenError('You can only view your own invitations');
        }
      }

      where.playerId = playerId;
    } else {
      // If no playerId specified, default to current user's invitations
      where.playerId = userId;
    }

    // Get total count and invitations in parallel
    const [total, invitations] = await Promise.all([
      prisma.teamInvitation.count({ where }),
      prisma.teamInvitation.findMany({
        where,
        include: {
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
          player: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          invitedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
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
  static async getInvitationById(invitationId: string, userId: string) {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
      include: {
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
        player: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        invitedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
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
  static async acceptInvitation(invitationId: string, userId: string) {
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
      // Update status to expired
      await prisma.teamInvitation.update({
        where: { id: invitationId },
        data: { status: 'EXPIRED' },
      });
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
      // Update invitation status
      const updatedInvitation = await tx.teamInvitation.update({
        where: { id: invitationId },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      });

      // Add player to team
      const teamMember = await tx.teamMember.create({
        data: {
          teamId: invitation.teamId,
          playerId: invitation.playerId,
          jerseyNumber: invitation.jerseyNumber,
          position: invitation.position,
        },
        include: {
          player: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return { invitation: updatedInvitation, teamMember };
    });

    return result;
  }

  /**
   * Reject an invitation
   * @param invitationId Invitation ID
   * @param userId User ID (must be the invited player)
   */
  static async rejectInvitation(invitationId: string, userId: string) {
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
      include: {
        team: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return updatedInvitation;
  }

  /**
   * Cancel an invitation (must have canManageRoster permission)
   * @param invitationId Invitation ID
   * @param userId User ID
   */
  static async cancelInvitation(invitationId: string, userId: string) {
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
    });

    return updatedInvitation;
  }

  /**
   * Get an invitation by token (public, no user context required).
   * Returns a limited view safe to expose without authentication.
   */
  static async getInvitationByToken(token: string) {
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
  static async acceptInvitationByToken(token: string) {
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
      await prisma.teamInvitation.update({
        where: { token },
        data: { status: 'EXPIRED' },
      });
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
      const updatedInvitation = await tx.teamInvitation.update({
        where: { token },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

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
   * Expire old invitations (background job)
   * Should be run periodically to mark expired invitations
   */
  static async expireOldInvitations() {
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
