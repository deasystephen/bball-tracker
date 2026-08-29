/**
 * Game service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { CreateGameInput, UpdateGameInput, GameQueryParams } from '../api/games/schemas';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { hasTeamPermission, canAccessTeam, isSystemAdmin } from '../utils/permissions';
import { GuardianService } from './guardian-service';
import { StatsService } from './stats-service';
import { logger } from '../utils/logger';
import { emitGameStatusChange, emitGameScoreChange } from '../websocket/emit';
import { computeHomeScore } from './game-event-service';

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
        // Same roster order as team-service TEAM_INCLUDE.members.
        orderBy: [
          { jerseyNumber: { sort: 'asc', nulls: 'last' } },
          { player: { name: 'asc' } },
        ],
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
type GameDetailMember = GameDetail['team']['members'][number];
/**
 * `GET /games/:id` payload. Mirrors `TeamDetailView`: member `player.email`
 * is present only when the caller has `canManageRoster` on the game's team
 * (role matrix B2.5); players and stats-only staff get `{ id, name }`. Staff
 * emails stay (coach contact info), as on the team detail.
 */
export type GameDetailView = Omit<GameDetail, 'team'> & {
  team: Omit<GameDetail['team'], 'members'> & {
    members: Array<
      Omit<GameDetailMember, 'player'> & {
        player: Omit<GameDetailMember['player'], 'email'> & { email?: string | null };
      }
    >;
  };
};
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
  static async getGameById(gameId: string, userId: string): Promise<GameDetailView> {
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

    // Same rule as TeamService.getTeamById: roster managers see member
    // emails, everyone else gets names only.
    const canManageRoster = await hasTeamPermission(userId, game.teamId, 'canManageRoster');
    if (canManageRoster) {
      return game;
    }

    return {
      ...game,
      team: {
        ...game.team,
        members: game.team.members.map(({ player, ...member }) => ({
          ...member,
          player: { id: player.id, name: player.name },
        })),
      },
    };
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
      // Filter by user access (staff, team member, or league admin) — the
      // same set canAccessTeam grants (audit #29).
      // Guardians (PARENT role) also see games of the teams their children
      // play on (docs/plans/parent-role-spec.md).
      const childIds = await GuardianService.getChildIds(userId);
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
            {
              season: {
                league: {
                  admins: {
                    some: {
                      userId,
                    },
                  },
                },
              },
            },
            ...(childIds.length > 0 ? [{ members: { some: { playerId: { in: childIds } } } }] : []),
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

    // Access check runs before any field-specific branch so an empty or
    // unrecognised body can never leak the game + staff payload (audit #12).
    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this game');
    }

    const isScoreOnlyUpdate =
      data.homeScore !== undefined || data.awayScore !== undefined;
    const isStatusUpdate = data.status !== undefined;
    const isOtherUpdate = data.opponent !== undefined || data.date !== undefined;

    if (!isScoreOnlyUpdate && !isStatusUpdate && !isOtherUpdate) {
      throw new BadRequestError('No fields to update');
    }

    // Check permission - canManageTeam for full updates, canTrackStats for score updates during game
    const canManage = await hasTeamPermission(userId, game.teamId, 'canManageTeam');
    const canTrack = await hasTeamPermission(userId, game.teamId, 'canTrackStats');

    // Once a game is FINISHED its status and score are part of the record;
    // reopening or rewriting it takes roster-management-level staff, not a
    // stats tracker (audit #78).
    if (game.status === 'FINISHED' && (isStatusUpdate || isScoreOnlyUpdate)) {
      const canManageRoster = await hasTeamPermission(userId, game.teamId, 'canManageRoster');
      if (!canManageRoster) {
        throw new ForbiddenError(
          'Only roster managers can change the status or score of a finished game'
        );
      }
    }

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
      // The home score is derived from SHOT events (see GameEventService), so
      // a client-supplied value is only honoured for a game with no shots on
      // record (e.g. a final score entered for a game not tracked in-app).
      // Otherwise the derived score is re-persisted, which also self-heals
      // games saved with an undercounted score by older clients.
      const shots = await prisma.gameEvent.findMany({
        where: { gameId, eventType: 'SHOT' },
        select: { eventType: true, metadata: true },
      });
      updateData.homeScore = shots.length === 0 ? data.homeScore : computeHomeScore(shots);
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

    // Broadcast score edits that don't come from an event (opponent points,
    // manual corrections) so spectators don't lag behind the tracker.
    if (
      updatedGame.homeScore !== game.homeScore ||
      updatedGame.awayScore !== game.awayScore
    ) {
      emitGameScoreChange(gameId, {
        gameId,
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
