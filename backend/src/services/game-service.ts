/**
 * Game service layer for business logic
 */

import prisma from '../models';
import { CreateGameInput, UpdateGameInput, GameQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam, isSystemAdmin } from '../utils/permissions';
import { StatsService } from './stats-service';

export class GameService {
  /**
   * Create a new game
   * @param data Game creation data
   * @param userId ID of the user creating the game (must have canManageTeam permission)
   */
  static async createGame(data: CreateGameInput, userId: string) {
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
      include: {
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
      },
    });

    return game;
  }

  /**
   * Get a game by ID
   * @param gameId Game ID
   * @param userId User ID (for authorization)
   */
  static async getGameById(gameId: string, userId: string) {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
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
      },
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
  static async listGames(query: GameQueryParams, userId: string) {
    // Build where clause
    const where: any = {};

    if (query.teamId) {
      where.teamId = query.teamId;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.startDate || query.endDate) {
      where.date = {};
      if (query.startDate) {
        where.date.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        where.date.lte = new Date(query.endDate);
      }
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
        if (where.teamId) {
          if (!teamIds.includes(where.teamId)) {
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

    // Get total count
    const total = await prisma.game.count({ where });

    // Get games
    const games = await prisma.game.findMany({
      where,
      include: {
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
      },
      orderBy: {
        date: 'desc',
      },
      take: query.limit,
      skip: query.offset,
    });

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
  static async updateGame(gameId: string, data: UpdateGameInput, userId: string) {
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
    const updateData: any = {};

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
      include: {
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
      },
    });

    // Finalize stats when game is marked as FINISHED
    if (updateData.status === 'FINISHED') {
      try {
        await StatsService.finalizeGameStats(gameId);
      } catch (error) {
        console.error('Error finalizing game stats:', error);
        // Don't fail the update if stats calculation fails
      }
    }

    return updatedGame;
  }

  /**
   * Delete a game
   * @param gameId Game ID
   * @param userId User ID (must have canManageTeam permission)
   */
  static async deleteGame(gameId: string, userId: string) {
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
