/**
 * Game Event service layer for business logic
 */

import prisma from '../models';
import { GameEventType, GameStatus, Prisma } from '@prisma/client';
import { CreateGameEventInput, GameEventQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam } from '../utils/permissions';
import { emitGameEvent, emitGameEventRemoved, GameScore } from '../websocket/emit';
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

const GAME_SCORE_SELECT = {
  homeScore: true,
  awayScore: true,
} satisfies Prisma.GameSelect;

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

/** Result of creating an event: the persisted event plus the post-change score. */
export interface CreateGameEventResult {
  event: GameEventWithPlayer;
  score: GameScore;
}

/** Result of deleting an event: the post-change score. */
export interface DeleteGameEventResult {
  success: true;
  score: GameScore;
}

interface GameAccess {
  game: GameForAccess;
  canTrackStats: boolean;
  canManageTeam: boolean;
}

interface ShotMetadata {
  made?: boolean;
  points?: number;
}

/**
 * Sum the home team's points from its SHOT events.
 *
 * Mirrors the scoring rule in `StatsService` (`points || 2`, counted only when
 * `made`). Non-SHOT events are ignored so callers may pass the full event log.
 */
export function computeHomeScore(
  events: ReadonlyArray<{ eventType: GameEventType; metadata: Prisma.JsonValue }>
): number {
  let total = 0;
  for (const event of events) {
    if (event.eventType !== GameEventType.SHOT) continue;
    const meta = (event.metadata ?? {}) as ShotMetadata;
    if (meta.made) {
      total += meta.points || 2;
    }
  }
  return total;
}

/**
 * Recompute and persist `homeScore` from the game's SHOT events.
 *
 * Must run inside an interactive transaction: the game row is locked with
 * `FOR UPDATE` so two concurrent shot writes can't both read a log that's
 * missing the other's insert and race to persist an undercounted score.
 */
export async function recomputeHomeScore(
  tx: Prisma.TransactionClient,
  gameId: string
): Promise<GameScore> {
  await tx.$queryRaw`SELECT "id" FROM "Game" WHERE "id" = ${gameId} FOR UPDATE`;

  const shots = await tx.gameEvent.findMany({
    where: { gameId, eventType: GameEventType.SHOT },
    select: { eventType: true, metadata: true },
  });

  const homeScore = computeHomeScore(shots);

  return tx.game.update({
    where: { id: gameId },
    data: { homeScore },
    select: GAME_SCORE_SELECT,
  });
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
   *
   * SHOT events change the home score, which is derived server-side from the
   * event log inside the same transaction as the insert (the client never
   * supplies it). The returned/broadcast `score` is the post-insert value.
   *
   * @param gameId Game ID
   * @param data Event creation data
   * @param userId ID of the user creating the event (must have canTrackStats permission)
   */
  static async createEvent(
    gameId: string,
    data: CreateGameEventInput,
    userId: string
  ): Promise<CreateGameEventResult> {
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

    const createData: Prisma.GameEventUncheckedCreateInput = {
      gameId,
      playerId: data.playerId || null,
      eventType: data.eventType,
      timestamp,
      metadata: (data.metadata || {}) as Prisma.InputJsonValue,
    };

    const result: CreateGameEventResult =
      data.eventType === GameEventType.SHOT
        ? await prisma.$transaction(async (tx) => {
            const event = await tx.gameEvent.create({
              data: createData,
              include: GAME_EVENT_INCLUDE,
            });
            const score = await recomputeHomeScore(tx, gameId);
            return { event, score };
          })
        : {
            event: await prisma.gameEvent.create({
              data: createData,
              include: GAME_EVENT_INCLUDE,
            }),
            score: { homeScore: game.homeScore, awayScore: game.awayScore },
          };

    // Broadcast to spectators in the game room. `emitGameEvent` no-ops if
    // Socket.io isn't initialized (e.g., in tests or CLI scripts).
    emitGameEvent(gameId, result);

    await this.syncFinalizedStats(game);

    return result;
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
   *
   * Deleting a SHOT recomputes `homeScore` inside the same transaction. The
   * removal (with the post-delete score) is broadcast as `game-event-removed`.
   *
   * @param gameId Game ID
   * @param eventId Event ID
   * @param userId User ID (must have canTrackStats permission)
   */
  static async deleteEvent(
    gameId: string,
    eventId: string,
    userId: string
  ): Promise<DeleteGameEventResult> {
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

    let score: GameScore;
    if (event.eventType === GameEventType.SHOT) {
      score = await prisma.$transaction(async (tx) => {
        await tx.gameEvent.delete({ where: { id: eventId } });
        return recomputeHomeScore(tx, gameId);
      });
    } else {
      await prisma.gameEvent.delete({ where: { id: eventId } });
      score = { homeScore: game.homeScore, awayScore: game.awayScore };
    }

    emitGameEventRemoved(gameId, { gameId, eventId, score });

    await this.syncFinalizedStats(game);

    return { success: true, score };
  }
}
