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
   * @param userId User ID (must be coach)
   */
  static async createInvitation(
    teamId: string,
    data: CreateInvitationInput,
    userId: string
  ) {
    // Get team and verify access
    const team = await prisma.team.findUnique({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can send invitations');
    }

    // Verify player exists and is actually a player
    const player = await prisma.user.findUnique({
      where: { id: data.playerId },
    });

    if (!player) {
      throw new NotFoundError('Player not found');
    }

    if (player.role !== 'PLAYER') {
      throw new BadRequestError('Can only invite users with PLAYER role');
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
            league: {
              select: {
                id: true,
                name: true,
                season: true,
                year: true,
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
      // Verify user has access to this team (coach or player)
      const team = await prisma.team.findUnique({
        where: { id: teamId },
      });

      if (!team) {
        throw new NotFoundError('Team not found');
      }

      // Only coach or players on the team can see invitations
      if (team.coachId !== userId) {
        const isMember = await prisma.teamMember.findUnique({
          where: {
            teamId_playerId: {
              teamId,
              playerId: userId,
            },
          },
        });

        if (!isMember) {
          throw new ForbiddenError('You do not have access to this team\'s invitations');
        }
      }

      where.teamId = teamId;
    }

    if (playerId) {
      // Verify user is requesting their own invitations or is a coach
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

    // Get total count for pagination
    const total = await prisma.teamInvitation.count({ where });

    // Get invitations
    const invitations = await prisma.teamInvitation.findMany({
      where,
      include: {
        team: {
          select: {
            id: true,
            name: true,
            league: {
              select: {
                id: true,
                name: true,
                season: true,
                year: true,
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
    });

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
            league: {
              select: {
                id: true,
                name: true,
                season: true,
                year: true,
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

    // Verify user has access (coach, player, or team member)
    const team = await prisma.team.findUnique({
      where: { id: invitation.teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const isCoach = team.coachId === userId;
    const isPlayer = invitation.playerId === userId;
    const isMember = await prisma.teamMember.findUnique({
      where: {
        teamId_playerId: {
          teamId: invitation.teamId,
          playerId: userId,
        },
      },
    });

    if (!isCoach && !isPlayer && !isMember) {
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
   * Cancel an invitation (coach only)
   * @param invitationId Invitation ID
   * @param userId User ID (must be coach)
   */
  static async cancelInvitation(invitationId: string, userId: string) {
    const invitation = await prisma.teamInvitation.findUnique({
      where: { id: invitationId },
      include: {
        team: true,
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Verify user is the coach
    if (invitation.team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can cancel invitations');
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
