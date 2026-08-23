/**
 * Game Event service layer for business logic
 */

import prisma from '../models';
import { GameEventType, GameStatus, Prisma } from '@prisma/client';
import { CreateGameEventInput, GameEventQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam } from '../utils/permissions';
import { emitGameEvent } from '../websocket/emit';
import { StatsService } from './stats-service';
import { logger } from '../utils/logger';

const GAME_ACCESS_INCLUDE = {
  team: {
    include: {
      members: {
        select: {
          playerId: true,
        },
      },
    },
  },
} satisfies Prisma.GameInclude;

const GAME_EVENT_INCLUDE = {
  player: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.GameEventInclude;

type GameForAccess = Prisma.GameGetPayload<{ include: typeof GAME_ACCESS_INCLUDE }>;

export type GameEventWithPlayer = Prisma.GameEventGetPayload<{
  include: typeof GAME_EVENT_INCLUDE;
}>;

export interface GameEventList {
  events: GameEventWithPlayer[];
  total: number;
  limit: number;
  offset: number;
}

interface GameAccess {
  game: GameForAccess;
  canTrackStats: boolean;
  canManageTeam: boolean;
}

export class GameEventService {
  /**
   * Keep the stored box score in sync when events change on a game that is
   * already FINISHED. Failures are logged, not surfaced: the event write has
   * already succeeded and the next finalize will converge anyway.
   */
  private static async syncFinalizedStats(game: { id: string; status: GameStatus }): Promise<void> {
    try {
      await StatsService.refinalizeIfFinished(game);
    } catch (error) {
      logger.error('Error re-finalizing game stats after event change', {
        gameId: game.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Verify user has access to a game and return permissions
   * Returns the game and user permissions
   */
  private static async verifyGameAccess(gameId: string, userId: string): Promise<GameAccess> {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: GAME_ACCESS_INCLUDE,
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this game');
    }

    const canTrackStats = await hasTeamPermission(userId, game.teamId, 'canTrackStats');
    const canManageTeam = await hasTeamPermission(userId, game.teamId, 'canManageTeam');

    return { game, canTrackStats, canManageTeam };
  }

  /**
   * Create a new game event
   * @param gameId Game ID
   * @param data Event creation data
   * @param userId ID of the user creating the event (must have canTrackStats permission)
   */
  static async createEvent(
    gameId: string,
    data: CreateGameEventInput,
    userId: string
  ): Promise<GameEventWithPlayer> {
    const { game, canTrackStats } = await this.verifyGameAccess(gameId, userId);

    // Must have canTrackStats permission to create events
    if (!canTrackStats) {
      throw new ForbiddenError('You do not have permission to create game events');
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
      include: GAME_EVENT_INCLUDE,
    });

    // Broadcast to spectators in the game room. `emitGameEvent` no-ops if
    // Socket.io isn't initialized (e.g., in tests or CLI scripts).
    emitGameEvent(gameId, {
      event,
      score: { homeScore: game.homeScore, awayScore: game.awayScore },
    });

    await this.syncFinalizedStats(game);

    return event;
  }

  /**
   * List events for a game
   * @param gameId Game ID
   * @param query Query parameters for filtering/pagination
   * @param userId User ID (for authorization)
   */
  static async listEvents(
    gameId: string,
    query: GameEventQueryParams,
    userId: string
  ): Promise<GameEventList> {
    await this.verifyGameAccess(gameId, userId);

    // Build where clause
    const where: Prisma.GameEventWhereInput = { gameId };

    if (query.eventType) {
      where.eventType = query.eventType as GameEventType;
    }

    if (query.playerId) {
      where.playerId = query.playerId;
    }

    // Get total count and events in parallel
    const [total, events] = await Promise.all([
      prisma.gameEvent.count({ where }),
      prisma.gameEvent.findMany({
        where,
        include: GAME_EVENT_INCLUDE,
        orderBy: {
          timestamp: 'desc',
        },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

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
  static async getEventById(
    gameId: string,
    eventId: string,
    userId: string
  ): Promise<GameEventWithPlayer> {
    await this.verifyGameAccess(gameId, userId);

    const event = await prisma.gameEvent.findUnique({
      where: { id: eventId },
      include: GAME_EVENT_INCLUDE,
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
   * @param userId User ID (must have canTrackStats permission)
   */
  static async deleteEvent(
    gameId: string,
    eventId: string,
    userId: string
  ): Promise<{ success: true }> {
    const { game, canTrackStats } = await this.verifyGameAccess(gameId, userId);

    // Must have canTrackStats permission to delete events (for undo functionality)
    if (!canTrackStats) {
      throw new ForbiddenError('You do not have permission to delete game events');
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

    await this.syncFinalizedStats(game);

    return { success: true };
  }
}
