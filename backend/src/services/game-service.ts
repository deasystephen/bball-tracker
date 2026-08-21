/**
 * Game service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { CreateGameInput, UpdateGameInput, GameQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam, isSystemAdmin } from '../utils/permissions';
import { StatsService } from './stats-service';
import { logger } from '../utils/logger';
import { emitGameStatusChange } from '../websocket/emit';

const GAME_INCLUDE = {
  team: {
    include: {
      season: {
        include: {
          league: true,
        },
      },
      staff: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          role: true,
        },
      },
    },
  },
} satisfies Prisma.GameInclude;

const GAME_DETAIL_INCLUDE = {
  team: {
    include: {
      ...GAME_INCLUDE.team.include,
      members: {
        include: {
          player: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  },
  events: {
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
  },
} satisfies Prisma.GameInclude;

const GAME_LIST_INCLUDE = {
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
} satisfies Prisma.GameInclude;

export type GameWithTeam = Prisma.GameGetPayload<{ include: typeof GAME_INCLUDE }>;
export type GameDetail = Prisma.GameGetPayload<{ include: typeof GAME_DETAIL_INCLUDE }>;
export type GameListItem = Prisma.GameGetPayload<{ include: typeof GAME_LIST_INCLUDE }>;

export interface GameList {
  games: GameListItem[];
  total: number;
  limit: number;
  offset: number;
}

export class GameService {
  /**
   * Create a new game
   * @param data Game creation data
   * @param userId ID of the user creating the game (must have canManageTeam permission)
   */
  static async createGame(data: CreateGameInput, userId: string): Promise<GameWithTeam> {
    // Verify team exists
    const team = await prisma.team.findUnique({
      where: { id: data.teamId },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(userId, data.teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to create games for this team');
    }

    // Convert date string to Date if needed
    const gameDate = typeof data.date === 'string' ? new Date(data.date) : data.date;

    // Create the game
    const game = await prisma.game.create({
      data: {
        teamId: data.teamId,
        opponent: data.opponent,
        date: gameDate,
        status: data.status || 'SCHEDULED',
        homeScore: data.homeScore || 0,
        awayScore: data.awayScore || 0,
      },
      include: GAME_INCLUDE,
    });

    return game;
  }

  /**
   * Get a game by ID
   * @param gameId Game ID
   * @param userId User ID (for authorization)
   */
  static async getGameById(gameId: string, userId: string): Promise<GameDetail> {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: GAME_DETAIL_INCLUDE,
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // Check if user has access
    const hasAccess = await canAccessTeam(userId, game.teamId);

    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this game');
    }

    return game;
  }

  /**
   * List games with filters
   * @param query Query parameters
   * @param userId User ID (for filtering by access)
   */
  static async listGames(query: GameQueryParams, userId: string): Promise<GameList> {
    // Build where clause
    const where: Prisma.GameWhereInput = {};

    if (query.teamId) {
      where.teamId = query.teamId;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.startDate || query.endDate) {
      const date: Prisma.DateTimeFilter = {};
      if (query.startDate) {
        date.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        date.lte = new Date(query.endDate);
      }
      where.date = date;
    }

    // Check if user is system admin (can see all games)
    const isSysAdmin = await isSystemAdmin(userId);

    if (!isSysAdmin) {
      // Filter by user access (staff or team member)
      const userTeams = await prisma.team.findMany({
        where: {
          OR: [
            {
              staff: {
                some: {
                  userId,
                },
              },
            },
            {
              members: {
                some: {
                  playerId: userId,
                },
              },
            },
          ],
        },
        select: { id: true },
      });

      const teamIds = userTeams.map((team) => team.id);
      if (teamIds.length > 0) {
        // If teamId was specified, verify user has access
        if (query.teamId) {
          if (!teamIds.includes(query.teamId)) {
            throw new ForbiddenError('You do not have access to this team');
          }
        } else {
          where.teamId = { in: teamIds };
        }
      } else {
        // User has no teams, return empty result
        return {
          games: [],
          total: 0,
          limit: query.limit,
          offset: query.offset,
        };
      }
    }

    // Get total count and games in parallel
    const [total, games] = await Promise.all([
      prisma.game.count({ where }),
      prisma.game.findMany({
        where,
        include: GAME_LIST_INCLUDE,
        orderBy: {
          date: 'desc',
        },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    return {
      games,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Update a game
   * @param gameId Game ID
   * @param data Update data
   * @param userId User ID (must have canManageTeam or canTrackStats permission)
   */
  static async updateGame(gameId: string, data: UpdateGameInput, userId: string): Promise<GameWithTeam> {
    // Get game
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // Check permission - canManageTeam for full updates, canTrackStats for score updates during game
    const canManage = await hasTeamPermission(userId, game.teamId, 'canManageTeam');
    const canTrack = await hasTeamPermission(userId, game.teamId, 'canTrackStats');

    // If only updating scores and game is IN_PROGRESS, allow with canTrackStats
    const isScoreOnlyUpdate =
      data.homeScore !== undefined || data.awayScore !== undefined;
    const isStatusUpdate = data.status !== undefined;
    const isOtherUpdate = data.opponent !== undefined || data.date !== undefined;

    if (!canManage) {
      if (isOtherUpdate) {
        throw new ForbiddenError('You do not have permission to update this game');
      }
      if (isStatusUpdate && !canTrack) {
        throw new ForbiddenError('You do not have permission to update game status');
      }
      if (isScoreOnlyUpdate && !canTrack) {
        throw new ForbiddenError('You do not have permission to update game scores');
      }
    }

    // Build update data
    const updateData: Prisma.GameUpdateInput = {};

    if (data.opponent !== undefined) {
      updateData.opponent = data.opponent;
    }

    if (data.date !== undefined) {
      updateData.date = typeof data.date === 'string' ? new Date(data.date) : data.date;
    }

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    if (data.homeScore !== undefined) {
      updateData.homeScore = data.homeScore;
    }

    if (data.awayScore !== undefined) {
      updateData.awayScore = data.awayScore;
    }

    // Update the game
    const updatedGame = await prisma.game.update({
      where: { id: gameId },
      data: updateData,
      include: GAME_INCLUDE,
    });

    // Finalize stats when game is marked as FINISHED
    if (updateData.status === 'FINISHED') {
      try {
        await StatsService.finalizeGameStats(gameId);
      } catch (error) {
        logger.error('Error finalizing game stats', { error: error instanceof Error ? error.message : String(error) });
        // Don't fail the update if stats calculation fails
      }
    }

    // Broadcast status transition to live spectators. No-ops when Socket.io
    // isn't initialized. Scores are included so clients can stay in sync even
    // if they missed the triggering event.
    if (updateData.status !== undefined && updateData.status !== game.status) {
      emitGameStatusChange(gameId, {
        gameId,
        previousStatus: game.status,
        status: updatedGame.status,
        score: {
          homeScore: updatedGame.homeScore,
          awayScore: updatedGame.awayScore,
        },
      });
    }

    return updatedGame;
  }

  /**
   * Delete a game
   * @param gameId Game ID
   * @param userId User ID (must have canManageTeam permission)
   */
  static async deleteGame(gameId: string, userId: string): Promise<{ success: true }> {
    // Get game
    const game = await prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    // Check permission
    const canManage = await hasTeamPermission(userId, game.teamId, 'canManageTeam');
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to delete this game');
    }

    // Delete the game (cascade will handle events)
    await prisma.game.delete({
      where: { id: gameId },
    });

    return { success: true };
  }
}
