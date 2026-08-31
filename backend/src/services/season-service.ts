/**
 * Season service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { CreateSeasonInput, UpdateSeasonInput, SeasonQueryParams } from '../api/seasons/schemas';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import {
  isLeagueAdmin,
  isSystemAdmin,
  getReadableLeagueIds,
  canReadLeague,
} from '../utils/permissions';

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
      throw new ForbiddenError('You do not have permission to create seasons for this league');
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
   * Get a season by ID.
   *
   * System admins and admins of the season's league get the full detail (team
   * staff with emails, rosters). Everyone else gets season metadata plus team
   * names only (`SEASON_INCLUDE`).
   * @param seasonId Season ID
   * @param userId Requesting user ID
   */
  static async getSeasonById(
    seasonId: string,
    userId: string
  ): Promise<SeasonDetail | SeasonWithTeams> {
    const season = await prisma.season.findUnique({
      where: { id: seasonId },
      include: SEASON_INCLUDE,
    });

    if (!season) {
      throw new NotFoundError('Season not found');
    }

    // Same rule and the same deviation note as `LeagueService.getLeagueById`:
    // there was no access check here at all. 404, not 403, so ids can't be
    // probed.
    if (!(await canReadLeague(userId, season.leagueId))) {
      throw new NotFoundError('Season not found');
    }

    const canManage = await isLeagueAdmin(userId, season.leagueId);
    if (!canManage) {
      return season;
    }

    const detail = await prisma.season.findUnique({
      where: { id: seasonId },
      include: SEASON_DETAIL_INCLUDE,
    });

    if (!detail) {
      throw new NotFoundError('Season not found');
    }

    return detail;
  }

  /**
   * List seasons with filters
   * @param query Query parameters
   */
  static async listSeasons(
    query: SeasonQueryParams,
    caller: { id: string; role: string }
  ): Promise<SeasonList> {
    // Scoped through the season's league (#443) — see `listLeagues` for the
    // reasoning. Filters are ANDed with the access clause, and the same `where`
    // feeds `count` and `findMany` so `total` is the scoped count.
    //
    // Deliberately WIDE: the id set means a member of one team sees every
    // season of that league, not only the seasons their team plays in. That
    // matches what `getLeagueById`'s public branch already returns.
    const isAdmin = caller.role === 'ADMIN';
    const conditions: Prisma.SeasonWhereInput[] = [];

    if (query.leagueId) {
      conditions.push({ leagueId: query.leagueId });
    }

    if (query.isActive !== undefined) {
      conditions.push({ isActive: query.isActive });
    }

    if (query.search) {
      conditions.push({ name: { contains: query.search, mode: 'insensitive' } });
    }

    if (isAdmin) {
      if (!query.includePersonal) {
        conditions.push({ league: { personalOwnerId: null } });
      }
    } else {
      const ids = await getReadableLeagueIds(caller.id);
      if (ids.length === 0) {
        return { seasons: [], total: 0, limit: query.limit, offset: query.offset };
      }
      conditions.push({ leagueId: { in: ids } });
    }

    const where: Prisma.SeasonWhereInput = conditions.length > 0 ? { AND: conditions } : {};

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
        league: { omit: { personalOwnerId: true } },
      },
    });

    if (!season) {
      throw new NotFoundError('Season not found');
    }

    // Check permission
    const canManage = await isLeagueAdmin(userId, season.leagueId);
    if (!canManage) {
      throw new ForbiddenError('You do not have permission to update this season');
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
    // `!== undefined` (not `??`): an explicit `null` means "clear the date" and
    // must not fall back to the stored value for the range check.
    const newStartDate = updateData.startDate !== undefined ? updateData.startDate : season.startDate;
    const newEndDate = updateData.endDate !== undefined ? updateData.endDate : season.endDate;
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
      throw new ForbiddenError('Only system administrators can delete seasons');
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
