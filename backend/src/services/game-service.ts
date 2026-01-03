/**
 * Game service layer for business logic
 */

import prisma from '../models';
import { CreateGameInput, UpdateGameInput, GameQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export class GameService {
  /**
   * Create a new game
   * @param data Game creation data
   * @param userId ID of the user creating the game (must be coach of the team)
   */
  static async createGame(data: CreateGameInput, userId: string) {
    // Verify team exists and user is the coach
    const team = await prisma.team.findUnique({
      where: { id: data.teamId },
      include: { coach: true },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    if (team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can create games');
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
            league: true,
            coach: {
              select: {
                id: true,
                name: true,
                email: true,
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
            league: true,
            coach: {
              select: {
                id: true,
                name: true,
                email: true,
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

    // Check if user has access (coach, team member, or admin)
    const hasAccess =
      game.team.coachId === userId ||
      game.team.members.some((member) => member.playerId === userId);

    // TODO: Add admin role check when roles are implemented
    // For now, allow access if user is coach or team member

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

    // Filter by user access (coach or team member)
    const userTeams = await prisma.team.findMany({
      where: {
        OR: [
          { coachId: userId },
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
      where.teamId = { in: teamIds };
    } else {
      // User has no teams, return empty result
      return {
        games: [],
        total: 0,
        limit: query.limit,
        offset: query.offset,
      };
    }

    // Get total count
    const total = await prisma.game.count({ where });

    // Get games
    const games = await prisma.game.findMany({
      where,
      include: {
        team: {
          include: {
            league: true,
            coach: {
              select: {
                id: true,
                name: true,
                email: true,
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
   * @param userId User ID (must be coach)
   */
  static async updateGame(gameId: string, data: UpdateGameInput, userId: string) {
    // Get game and verify access
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        team: true,
      },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    if (game.team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can update games');
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
            league: true,
            coach: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    return updatedGame;
  }

  /**
   * Delete a game
   * @param gameId Game ID
   * @param userId User ID (must be coach)
   */
  static async deleteGame(gameId: string, userId: string) {
    // Get game and verify access
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        team: true,
      },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    if (game.team.coachId !== userId) {
      throw new ForbiddenError('Only the team coach can delete games');
    }

    // Delete the game (cascade will handle events)
    await prisma.game.delete({
      where: { id: gameId },
    });

    return { success: true };
  }
}
