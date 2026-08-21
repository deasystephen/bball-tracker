/**
 * Season service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { CreateSeasonInput, UpdateSeasonInput, SeasonQueryParams } from '../api/seasons/schemas';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { isLeagueAdmin, isSystemAdmin } from '../utils/permissions';

const LEAGUE_SUMMARY_SELECT = {
  id: true,
  name: true,
} satisfies Prisma.LeagueSelect;

const SEASON_INCLUDE = {
  league: { select: LEAGUE_SUMMARY_SELECT },
  teams: {
    select: {
      id: true,
      name: true,
    },
  },
  _count: {
    select: {
      teams: true,
    },
  },
} satisfies Prisma.SeasonInclude;

const SEASON_DETAIL_INCLUDE = {
  league: { select: LEAGUE_SUMMARY_SELECT },
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
      _count: {
        select: {
          members: true,
          games: true,
        },
      },
    },
    orderBy: {
      name: 'asc',
    },
  },
  _count: {
    select: {
      teams: true,
    },
  },
} satisfies Prisma.SeasonInclude;

const SEASON_LIST_INCLUDE = {
  league: { select: LEAGUE_SUMMARY_SELECT },
  _count: {
    select: {
      teams: true,
    },
  },
} satisfies Prisma.SeasonInclude;

export type SeasonWithTeams = Prisma.SeasonGetPayload<{ include: typeof SEASON_INCLUDE }>;
export type SeasonDetail = Prisma.SeasonGetPayload<{ include: typeof SEASON_DETAIL_INCLUDE }>;
export type SeasonListItem = Prisma.SeasonGetPayload<{ include: typeof SEASON_LIST_INCLUDE }>;

export interface SeasonList {
  seasons: SeasonListItem[];
  total: number;
  limit: number;
  offset: number;
}

export class SeasonService {
  /**
   * Create a new season
   * @param data Season creation data
   * @param userId User ID (must be league admin or system admin)
   */
  static async createSeason(data: CreateSeasonInput, userId: string): Promise<SeasonWithTeams> {
    // Verify league exists
    const league = await prisma.league.findUnique({
      where: { id: data.leagueId },
    });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    // Check permission
    const canManage = await isLeagueAdmin(userId, data.leagueId);
    if (!canManage) {
      throw new BadRequestError('You do not have permission to create seasons for this league');
    }

    // Check if season with same name already exists in this league
    const existing = await prisma.season.findUnique({
      where: {
        leagueId_name: {
          leagueId: data.leagueId,
          name: data.name,
        },
      },
    });

    if (existing) {
      throw new BadRequestError('A season with this name already exists in this league');
    }

    // Validate date range if both dates provided
    if (data.startDate && data.endDate && data.startDate > data.endDate) {
      throw new BadRequestError('Start date must be before end date');
    }

    // Create the season
    const season = await prisma.season.create({
      data: {
        leagueId: data.leagueId,
        name: data.name,
        startDate: data.startDate,
        endDate: data.endDate,
        isActive: true,
      },
      include: SEASON_INCLUDE,
    });

    return season;
  }

  /**
   * Get a season by ID
   * @param seasonId Season ID
   */
  static async getSeasonById(seasonId: string): Promise<SeasonDetail> {
    const season = await prisma.season.findUnique({
      where: { id: seasonId },
      include: SEASON_DETAIL_INCLUDE,
    });

    if (!season) {
      throw new NotFoundError('Season not found');
    }

    return season;
  }

  /**
   * List seasons with filters
   * @param query Query parameters
   */
  static async listSeasons(query: SeasonQueryParams): Promise<SeasonList> {
    // Build where clause
    const where: Prisma.SeasonWhereInput = {};

    if (query.leagueId) {
      where.leagueId = query.leagueId;
    }

    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }

    if (query.search) {
      where.name = {
        contains: query.search,
        mode: 'insensitive',
      };
    }

    // Get total count and seasons in parallel
    const [total, seasons] = await Promise.all([
      prisma.season.count({ where }),
      prisma.season.findMany({
        where,
        include: SEASON_LIST_INCLUDE,
        orderBy: [
          { isActive: 'desc' },
          { startDate: 'desc' },
          { createdAt: 'desc' },
        ],
        take: query.limit,
        skip: query.offset,
      }),
    ]);

    return {
      seasons,
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Update a season
   * @param seasonId Season ID
   * @param data Update data
   * @param userId User ID (must be league admin or system admin)
   */
  static async updateSeason(
    seasonId: string,
    data: UpdateSeasonInput,
    userId: string
  ): Promise<SeasonWithTeams> {
    // Get season
    const season = await prisma.season.findUnique({
      where: { id: seasonId },
      include: {
        league: true,
      },
    });

    if (!season) {
      throw new NotFoundError('Season not found');
    }

    // Check permission
    const canManage = await isLeagueAdmin(userId, season.leagueId);
    if (!canManage) {
      throw new BadRequestError('You do not have permission to update this season');
    }

    // Build update data
    const updateData: Prisma.SeasonUpdateInput = {};

    if (data.name !== undefined) {
      // Check for duplicate name
      const existing = await prisma.season.findFirst({
        where: {
          leagueId: season.leagueId,
          name: data.name,
          id: { not: seasonId },
        },
      });

      if (existing) {
        throw new BadRequestError('A season with this name already exists in this league');
      }

      updateData.name = data.name;
    }

    if (data.startDate !== undefined) {
      updateData.startDate = data.startDate;
    }

    if (data.endDate !== undefined) {
      updateData.endDate = data.endDate;
    }

    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
    }

    // Validate date range
    const newStartDate = updateData.startDate ?? season.startDate;
    const newEndDate = updateData.endDate ?? season.endDate;
    if (newStartDate && newEndDate && newStartDate > newEndDate) {
      throw new BadRequestError('Start date must be before end date');
    }

    // Update the season
    const updatedSeason = await prisma.season.update({
      where: { id: seasonId },
      data: updateData,
      include: SEASON_INCLUDE,
    });

    return updatedSeason;
  }

  /**
   * Delete a season
   * @param seasonId Season ID
   * @param userId User ID (must be system admin)
   */
  static async deleteSeason(seasonId: string, userId: string): Promise<{ success: true }> {
    // Check if user is system admin
    const isSysAdmin = await isSystemAdmin(userId);
    if (!isSysAdmin) {
      throw new BadRequestError('Only system administrators can delete seasons');
    }

    // Get season
    const season = await prisma.season.findUnique({
      where: { id: seasonId },
      include: {
        teams: true,
      },
    });

    if (!season) {
      throw new NotFoundError('Season not found');
    }

    // Check if season has teams
    if (season.teams.length > 0) {
      throw new BadRequestError('Cannot delete season with existing teams. Remove teams first.');
    }

    // Delete the season
    await prisma.season.delete({
      where: { id: seasonId },
    });

    return { success: true };
  }
}
