/**
 * Game Event service layer for business logic
 */

import prisma from '../models';
import { GameEventType, Prisma } from '@prisma/client';
import { CreateGameEventInput, GameEventQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export class GameEventService {
  /**
   * Verify user has access to a game (coach or team member)
   * Returns the game with team info if access is granted
   */
  private static async verifyGameAccess(gameId: string, userId: string) {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        team: {
          include: {
            members: {
              select: {
                playerId: true,
              },
            },
          },
        },
      },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const isCoach = game.team.coachId === userId;
    const isTeamMember = game.team.members.some((member) => member.playerId === userId);

    if (!isCoach && !isTeamMember) {
      throw new ForbiddenError('You do not have access to this game');
    }

    return { game, isCoach };
  }

  /**
   * Create a new game event
   * @param gameId Game ID
   * @param data Event creation data
   * @param userId ID of the user creating the event (must be coach or team member)
   */
  static async createEvent(gameId: string, data: CreateGameEventInput, userId: string) {
    const { game, isCoach } = await this.verifyGameAccess(gameId, userId);
    const isTeamMember = game.team.members.some((member) => member.playerId === userId);

    // Only coach or team members can create events
    if (!isCoach && !isTeamMember) {
      throw new ForbiddenError('Only team coach or members can create game events');
    }

    // Verify player exists and is on the team if playerId is provided
    if (data.playerId) {
      const isPlayerOnTeam = game.team.members.some(
        (member) => member.playerId === data.playerId
      );
      if (!isPlayerOnTeam) {
        throw new ForbiddenError('Player is not a member of this team');
      }
    }

    // Convert timestamp string to Date if needed
    const timestamp = data.timestamp
      ? typeof data.timestamp === 'string'
        ? new Date(data.timestamp)
        : data.timestamp
      : new Date();

    const event = await prisma.gameEvent.create({
      data: {
        gameId,
        playerId: data.playerId || null,
        eventType: data.eventType,
        timestamp,
        metadata: (data.metadata || {}) as Prisma.InputJsonValue,
      },
      include: {
        player: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return event;
  }

  /**
   * List events for a game
   * @param gameId Game ID
   * @param query Query parameters for filtering/pagination
   * @param userId User ID (for authorization)
   */
  static async listEvents(gameId: string, query: GameEventQueryParams, userId: string) {
    await this.verifyGameAccess(gameId, userId);

    // Build where clause
    const where: Prisma.GameEventWhereInput = { gameId };

    if (query.eventType) {
      where.eventType = query.eventType as GameEventType;
    }

    if (query.playerId) {
      where.playerId = query.playerId;
    }

    // Get total count
    const total = await prisma.gameEvent.count({ where });

    // Get events
    const events = await prisma.gameEvent.findMany({
      where,
      include: {
        player: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        timestamp: 'asc',
      },
      take: query.limit,
      skip: query.offset,
    });

    return {
      events,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Get a single event by ID
   * @param gameId Game ID
   * @param eventId Event ID
   * @param userId User ID (for authorization)
   */
  static async getEventById(gameId: string, eventId: string, userId: string) {
    await this.verifyGameAccess(gameId, userId);

    const event = await prisma.gameEvent.findUnique({
      where: { id: eventId },
      include: {
        player: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundError('Game event not found');
    }

    if (event.gameId !== gameId) {
      throw new NotFoundError('Game event not found');
    }

    return event;
  }

  /**
   * Delete a game event
   * @param gameId Game ID
   * @param eventId Event ID
   * @param userId User ID (must be coach)
   */
  static async deleteEvent(gameId: string, eventId: string, userId: string) {
    const { isCoach } = await this.verifyGameAccess(gameId, userId);

    if (!isCoach) {
      throw new ForbiddenError('Only the team coach can delete game events');
    }

    const event = await prisma.gameEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundError('Game event not found');
    }

    if (event.gameId !== gameId) {
      throw new NotFoundError('Game event not found');
    }

    await prisma.gameEvent.delete({
      where: { id: eventId },
    });

    return { success: true };
  }
}
