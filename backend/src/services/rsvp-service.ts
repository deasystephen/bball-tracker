/**
 * RSVP service layer for game attendance tracking
 */

import prisma from '../models';
import { RsvpStatus } from '@prisma/client';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { canAccessTeam } from '../utils/permissions';

export class RsvpService {
  /**
   * Upsert an RSVP for a game (one response per user per game)
   */
  static async upsertRsvp(gameId: string, userId: string, status: RsvpStatus) {
    // Verify game exists and get team info
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true, teamId: true },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // Verify user has access to this team
    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const rsvp = await prisma.gameRsvp.upsert({
      where: {
        gameId_userId: { gameId, userId },
      },
      create: {
        gameId,
        userId,
        status,
      },
      update: {
        status,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return rsvp;
  }

  /**
   * Get all RSVPs for a game with counts
   */
  static async getGameRsvps(gameId: string, userId: string) {
    // Verify game exists and get team info
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true, teamId: true },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // Verify user has access to this team
    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }

    const [rsvps, counts] = await Promise.all([
      prisma.gameRsvp.findMany({
        where: { gameId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.gameRsvp.groupBy({
        by: ['status'],
        where: { gameId },
        _count: { status: true },
      }),
    ]);

    const summary = {
      yes: 0,
      no: 0,
      maybe: 0,
    };

    for (const count of counts) {
      const key = count.status.toLowerCase() as keyof typeof summary;
      summary[key] = count._count.status;
    }

    return { rsvps, summary };
  }

  /**
   * Get a user's RSVP for a specific game
   */
  static async getUserRsvp(gameId: string, userId: string) {
    return prisma.gameRsvp.findUnique({
      where: {
        gameId_userId: { gameId, userId },
      },
    });
  }
}
