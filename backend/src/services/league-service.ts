/**
 * League service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { CreateLeagueInput, UpdateLeagueInput, LeagueQueryParams } from '../api/leagues/schemas';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import { isSystemAdmin, isLeagueAdmin } from '../utils/permissions';

const LEAGUE_ADMIN_INCLUDE = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} satisfies Prisma.LeagueAdminInclude;

const LEAGUE_INCLUDE = {
  seasons: {
    include: {
      teams: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  admins: {
    include: LEAGUE_ADMIN_INCLUDE,
  },
} satisfies Prisma.LeagueInclude;

const LEAGUE_DETAIL_INCLUDE = {
  seasons: {
    include: {
      teams: {
        include: {
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
                },
              },
            },
          },
        },
      },
    },
    orderBy: {
      startDate: 'desc',
    },
  },
  admins: {
    include: LEAGUE_ADMIN_INCLUDE,
  },
} satisfies Prisma.LeagueInclude;

/**
 * What a non-admin sees on `GET /leagues/:id`: league metadata plus season
 * and team names. No staff, no member lists, no admin emails (audit #4).
 */
const LEAGUE_PUBLIC_INCLUDE = {
  seasons: {
    include: {
      teams: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: {
      startDate: 'desc',
    },
  },
} satisfies Prisma.LeagueInclude;

const LEAGUE_LIST_INCLUDE = {
  seasons: {
    select: {
      id: true,
      name: true,
      isActive: true,
    },
    orderBy: {
      startDate: 'desc',
    },
  },
  _count: {
    select: {
      seasons: true,
    },
  },
} satisfies Prisma.LeagueInclude;

const SEASON_INCLUDE = {
  league: true,
  teams: true,
} satisfies Prisma.SeasonInclude;

export type LeagueWithSeasons = Prisma.LeagueGetPayload<{ include: typeof LEAGUE_INCLUDE }>;
export type LeagueDetail = Prisma.LeagueGetPayload<{ include: typeof LEAGUE_DETAIL_INCLUDE }>;
export type LeaguePublicDetail = Prisma.LeagueGetPayload<{ include: typeof LEAGUE_PUBLIC_INCLUDE }>;
export type LeagueListItem = Prisma.LeagueGetPayload<{ include: typeof LEAGUE_LIST_INCLUDE }>;
export type LeagueAdminWithUser = Prisma.LeagueAdminGetPayload<{
  include: typeof LEAGUE_ADMIN_INCLUDE;
}>;
export type SeasonWithLeagueAndTeams = Prisma.SeasonGetPayload<{ include: typeof SEASON_INCLUDE }>;

export interface LeagueList {
  leagues: LeagueListItem[];
  total: number;
  limit: number;
  offset: number;
}

export class LeagueService {
  /**
   * Create a new league
   * @param data League creation data
   * @param userId User ID (must be system admin)
   */
  static async createLeague(data: CreateLeagueInput, userId: string): Promise<LeagueWithSeasons> {
    // Check if user is system admin
    const isSysAdmin = await isSystemAdmin(userId);
    if (!isSysAdmin) {
      throw new ForbiddenError('Only system administrators can create leagues');
    }

    // Check if league with same name already exists
    const existing = await prisma.league.findFirst({
      where: {
        name: data.name,
      },
    });

    if (existing) {
      throw new BadRequestError('League with this name already exists');
    }

    // Create the league
    const league = await prisma.league.create({
      data: {
        name: data.name,
      },
      include: LEAGUE_INCLUDE,
    });

    return league;
  }

  /**
   * Get a league by ID.
   *
   * System admins and admins of this league get the full detail (admins with
   * emails, team staff, rosters). Everyone else gets league metadata plus
   * season and team names only.
   * @param leagueId League ID
   * @param userId Requesting user ID
   */
  static async getLeagueById(
    leagueId: string,
    userId: string
  ): Promise<LeagueDetail | LeaguePublicDetail> {
    const canManage = await isLeagueAdmin(userId, leagueId);

    const league = canManage
      ? await prisma.league.findUnique({
          where: { id: leagueId },
          include: LEAGUE_DETAIL_INCLUDE,
        })
      : await prisma.league.findUnique({
          where: { id: leagueId },
          include: LEAGUE_PUBLIC_INCLUDE,
        });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    return league;
  }

  /**
   * List leagues with filters
   * @param query Query parameters
   */
  static async listLeagues(query: LeagueQueryParams): Promise<LeagueList> {
    // Build where clause
    const where: Prisma.LeagueWhereInput = {};

    if (query.search) {
      where.name = {
        contains: query.search,
        mode: 'insensitive',
      };
    }

    // Get total count and leagues in parallel
    const [total, leagues] = await Promise.all([
      prisma.league.count({ where }),
      prisma.league.findMany({
        where,
        include: LEAGUE_LIST_INCLUDE,
        orderBy: {
          name: 'asc',
        },
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    return {
      leagues,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Update a league
   * @param leagueId League ID
   * @param data Update data
   * @param userId User ID (must be league admin or system admin)
   */
  static async updateLeague(
    leagueId: string,
    data: UpdateLeagueInput,
    userId: string
  ): Promise<LeagueWithSeasons> {
    // Get league
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    // Check permission
    const canManage = await isLeagueAdmin(userId, leagueId);
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to update this league');
    }

    // Build update data
    const updateData: Prisma.LeagueUpdateInput = {};

    if (data.name !== undefined) {
      // Same uniqueness rule as createLeague
      const existing = await prisma.league.findFirst({
        where: {
          name: data.name,
          id: { not: leagueId },
        },
      });

      if (existing) {
        throw new BadRequestError('League with this name already exists');
      }

      updateData.name = data.name;
    }

    // Update the league
    const updatedLeague = await prisma.league.update({
      where: { id: leagueId },
      data: updateData,
      include: LEAGUE_INCLUDE,
    });

    return updatedLeague;
  }

  /**
   * Delete a league
   * @param leagueId League ID
   * @param userId User ID (must be system admin)
   */
  static async deleteLeague(leagueId: string, userId: string): Promise<{ success: true }> {
    // Check if user is system admin
    const isSysAdmin = await isSystemAdmin(userId);
    if (!isSysAdmin) {
      throw new ForbiddenError('Only system administrators can delete leagues');
    }

    // Get league
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: {
        seasons: {
          include: {
            teams: true,
          },
        },
      },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    // Check if league has seasons with teams
    const hasTeams = league.seasons.some((s) => s.teams.length > 0);
    if (hasTeams) {
      throw new BadRequestError('Cannot delete league with existing teams. Remove teams first.');
    }

    // Delete the league (cascade will handle seasons)
    await prisma.league.delete({
      where: { id: leagueId },
    });

    return { success: true };
  }

  /**
   * Add a league admin
   * @param leagueId League ID
   * @param adminUserId User ID to add as admin
   * @param userId User ID making the request (must be system admin or existing league admin)
   */
  static async addLeagueAdmin(
    leagueId: string,
    adminUserId: string,
    userId: string
  ): Promise<LeagueAdminWithUser> {
    // Check permission
    const canManage = await isLeagueAdmin(userId, leagueId);
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to manage league admins');
    }

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: adminUserId },
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if already an admin
    const existing = await prisma.leagueAdmin.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId: adminUserId,
        },
      },
    });

    if (existing) {
      throw new BadRequestError('User is already an admin of this league');
    }

    // Add admin
    const leagueAdmin = await prisma.leagueAdmin.create({
      data: {
        leagueId,
        userId: adminUserId,
      },
      include: LEAGUE_ADMIN_INCLUDE,
    });

    return leagueAdmin;
  }

  /**
   * Remove a league admin
   * @param leagueId League ID
   * @param adminUserId User ID to remove as admin
   * @param userId User ID making the request (must be system admin)
   */
  static async removeLeagueAdmin(
    leagueId: string,
    adminUserId: string,
    userId: string
  ): Promise<{ success: true }> {
    // Only system admin can remove league admins
    const isSysAdmin = await isSystemAdmin(userId);
    if (!isSysAdmin) {
      throw new ForbiddenError('Only system administrators can remove league admins');
    }

    // Delete admin
    await prisma.leagueAdmin.delete({
      where: {
        leagueId_userId: {
          leagueId,
          userId: adminUserId,
        },
      },
    });

    return { success: true };
  }

  /**
   * Create a season within a league
   * @param leagueId League ID
   * @param data Season data
   * @param userId User ID (must be league admin)
   */
  static async createSeason(
    leagueId: string,
    data: { name: string; startDate?: Date; endDate?: Date },
    userId: string
  ): Promise<SeasonWithLeagueAndTeams> {
    // Check permission
    const canManage = await isLeagueAdmin(userId, leagueId);
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to create seasons for this league');
    }

    // Check if season with same name already exists
    const existing = await prisma.season.findUnique({
      where: {
        leagueId_name: {
          leagueId,
          name: data.name,
        },
      },
    });

    if (existing) {
      throw new BadRequestError('A season with this name already exists in this league');
    }

    // Create season
    const season = await prisma.season.create({
      data: {
        leagueId,
        name: data.name,
        startDate: data.startDate,
        endDate: data.endDate,
        isActive: true,
      },
      include: SEASON_INCLUDE,
    });

    return season;
  }
}
