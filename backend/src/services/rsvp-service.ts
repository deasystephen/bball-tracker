/**
 * RSVP service layer for game attendance tracking
 */

import prisma from '../models';
import { GameRsvp, Prisma, RsvpStatus } from '@prisma/client';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { canAccessTeam, hasTeamPermission, isGuardianOf } from '../utils/permissions';
import { mailer } from './mailer';
import { rsvpConfirmationTemplate } from './mailer/templates';
import { logger } from '../utils/logger';
import { formatEmailDateTime } from '../utils/format-date';

const RSVP_INCLUDE = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} satisfies Prisma.GameRsvpInclude;

export type RsvpWithUser = Prisma.GameRsvpGetPayload<{ include: typeof RSVP_INCLUDE }>;
/**
 * `GET /games/:id/rsvps` row. `user.email` is present only for callers with
 * `canManageRoster` on the game's team (plus the caller's own row); everyone
 * else gets `{ id, name }` (role matrix B2.5).
 */
export type RsvpView = Omit<RsvpWithUser, 'user'> & {
  user: Omit<RsvpWithUser['user'], 'email'> & { email?: string | null };
};

export interface RsvpSummary {
  yes: number;
  no: number;
  maybe: number;
}

export interface GameRsvps {
  rsvps: RsvpView[];
  summary: RsvpSummary;
}

export class RsvpService {
  /**
   * Upsert an RSVP for a game (one response per user per game)
   */
  static async upsertRsvp(
    gameId: string,
    userId: string,
    status: RsvpStatus,
    playerId?: string
  ): Promise<RsvpWithUser> {
    // Verify game exists and get team info
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: {
        id: true,
        teamId: true,
        opponent: true,
        date: true,
        team: { select: { name: true } },
      },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // RSVP on behalf of a child (PARENT role): the caller must be a guardian
    // of the player and the player must be rostered on the game's team. The
    // row is keyed on the player so the coach's RSVP roster stays per-player.
    const onBehalfOfChild = playerId !== undefined && playerId !== userId;
    let confirmationEmail: string | null = null;

    if (onBehalfOfChild) {
      if (!(await isGuardianOf(userId, playerId))) {
        throw new ForbiddenError('You can only RSVP for players you are a guardian of');
      }

      const member = await prisma.teamMember.findUnique({
        where: { teamId_playerId: { teamId: game.teamId, playerId } },
        select: { id: true },
      });
      if (!member) {
        throw new ForbiddenError('This player is not on the team playing this game');
      }

      const guardian = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      confirmationEmail = guardian?.email ?? null;
    } else {
      // Verify user has access to this team
      const hasAccess = await canAccessTeam(userId, game.teamId);
      if (!hasAccess) {
        throw new ForbiddenError('You do not have access to this team');
      }
    }

    const rsvpUserId = onBehalfOfChild ? playerId : userId;

    const rsvp = await prisma.gameRsvp.upsert({
      where: {
        gameId_userId: { gameId, userId: rsvpUserId },
      },
      create: {
        gameId,
        userId: rsvpUserId,
        status,
      },
      update: {
        status,
      },
      include: RSVP_INCLUDE,
    });

    // Send RSVP confirmation email (fire-and-forget; never block the response).
    // A guardian answering for a (usually email-less managed) child gets the
    // confirmation at their own address.
    const to = onBehalfOfChild ? confirmationEmail : rsvp.user.email;
    if (to) {
      mailer
        .send({
          template: rsvpConfirmationTemplate,
          to,
          variables: {
            playerName: rsvp.user.name ?? to,
            teamName: game.team.name,
            opponent: game.opponent,
            gameDate: formatEmailDateTime(game.date),
            rsvpStatus: status,
          },
          metadata: {
            userId,
            event_type: 'rsvp.upserted',
            gameId,
            rsvpStatus: status,
          },
        })
        .catch((err: unknown) => {
          logger.error('Failed to send RSVP confirmation email', {
            error: err instanceof Error ? err.message : String(err),
            gameId,
            userId,
          });
        });
    }

    return rsvp;
  }

  /**
   * Get all RSVPs for a game with counts
   */
  static async getGameRsvps(gameId: string, userId: string): Promise<GameRsvps> {
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

    const [rows, counts, canManageRoster] = await Promise.all([
      prisma.gameRsvp.findMany({
        where: { gameId },
        include: RSVP_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.gameRsvp.groupBy({
        by: ['status'],
        where: { gameId },
        _count: { status: true },
      }),
      hasTeamPermission(userId, game.teamId, 'canManageRoster'),
    ]);

    // Roster managers see everyone's email; other team members only their own.
    const rsvps: RsvpView[] = canManageRoster
      ? rows
      : rows.map(({ user, ...rsvp }) => ({
          ...rsvp,
          user: user.id === userId ? user : { id: user.id, name: user.name },
        }));

    const summary: RsvpSummary = {
      yes: 0,
      no: 0,
      maybe: 0,
    };

    for (const count of counts) {
      const key = count.status.toLowerCase() as keyof RsvpSummary;
      summary[key] = count._count.status;
    }

    return { rsvps, summary };
  }

  /**
   * Get a user's RSVP for a specific game
   */
  static async getUserRsvp(gameId: string, userId: string): Promise<GameRsvp | null> {
    return prisma.gameRsvp.findUnique({
      where: {
        gameId_userId: { gameId, userId },
      },
    });
  }
}
