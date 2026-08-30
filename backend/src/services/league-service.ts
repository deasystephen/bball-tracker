/**
 * League service layer for business logic
 */

import { Prisma } from '@prisma/client';
import prisma from '../models';
import { CreateLeagueInput, UpdateLeagueInput, LeagueQueryParams } from '../api/leagues/schemas';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import { isSystemAdmin, isLeagueAdmin, getReadableLeagueIds, canReadLeague } from '../utils/permissions';

/**
 * `League.personalOwnerId` marks a coach's auto-provisioned personal container
 * (#442). It is an internal marker and never belongs in an API payload, so
 * every League read here omits it. The client-facing form is the derived
 * `isPersonal` boolean on the list. The access helpers in `utils/permissions`
 * select the column explicitly when they need it.
 */
const LEAGUE_OMIT = { personalOwnerId: true } satisfies Prisma.LeagueOmit;

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
  league: { omit: { personalOwnerId: true } },
  teams: true,
} satisfies Prisma.SeasonInclude;

export type LeagueWithSeasons = Prisma.LeagueGetPayload<{
  include: typeof LEAGUE_INCLUDE;
  omit: typeof LEAGUE_OMIT;
}>;
export type LeagueDetail = Prisma.LeagueGetPayload<{
  include: typeof LEAGUE_DETAIL_INCLUDE;
  omit: typeof LEAGUE_OMIT;
}>;
export type LeaguePublicDetail = Prisma.LeagueGetPayload<{
  include: typeof LEAGUE_PUBLIC_INCLUDE;
  omit: typeof LEAGUE_OMIT;
}>;
type LeagueListRow = Prisma.LeagueGetPayload<{ include: typeof LEAGUE_LIST_INCLUDE }>;

/**
 * A list row as clients see it: `personalOwnerId` replaced by the derived
 * `isPersonal` flag. Mobile branches its create-team UI on this (#442) — when
 * every visible league is personal the league/season pickers are hidden
 * entirely, so the coach never meets the words "league" or "season".
 */
export type LeagueListItem = Omit<LeagueListRow, 'personalOwnerId'> & { isPersonal: boolean };
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
      omit: LEAGUE_OMIT,
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
    // #443 deviation, deliberate and recorded in the PR: that issue says detail
    // authorization "is already correct" and not to touch it. It was written
    // before personal leagues existed. There was in fact NO access check here —
    // `isLeagueAdmin` only selected which `include` to use, so any authenticated
    // caller got every season and every team name of any league they could name
    // an id for. And the id is not a secret: `TEAM_INCLUDE` is
    // `season: { include: { league } }` (team-service.ts), so every member and
    // guardian already holds it from the happy path. For a personal league that
    // is the coach's whole portfolio, readable by any parent on any one team.
    //
    // 404 rather than 403, matching `PlayerService.getPlayerById`, so ids can't
    // be probed.
    if (!(await canReadLeague(userId, leagueId))) {
      throw new NotFoundError('League not found');
    }

    const canManage = await isLeagueAdmin(userId, leagueId);

    const league = canManage
      ? await prisma.league.findUnique({
          where: { id: leagueId },
          include: LEAGUE_DETAIL_INCLUDE,
          omit: LEAGUE_OMIT,
        })
      : await prisma.league.findUnique({
          where: { id: leagueId },
          include: LEAGUE_PUBLIC_INCLUDE,
          omit: LEAGUE_OMIT,
        });

    if (!league) {
      throw new NotFoundError('League not found');
    }

    return league;
  }

  /**
   * List leagues the caller may see (#443).
   *
   * Before this, the `where` was built from query filters only — every
   * authenticated user could enumerate every organisation's leagues, and the
   * create-team picker rendered that global list. The access clause is ANDed
   * with the filters, never substituted for them, so `search` can't be used as
   * a scoping bypass, and the SAME `where` object feeds `count` and
   * `findMany` so `total` is the scoped count rather than the global one.
   *
   * @param query Query parameters
   * @param caller Authenticated caller; `role` comes from the freshly-loaded
   *   DB row on `req.user`, so no extra `isSystemAdmin` query is needed.
   */
  static async listLeagues(
    query: LeagueQueryParams,
    caller: { id: string; role: string }
  ): Promise<LeagueList> {
    const isAdmin = caller.role === 'ADMIN';
    const conditions: Prisma.LeagueWhereInput[] = [];

    if (query.search) {
      conditions.push({ name: { contains: query.search, mode: 'insensitive' } });
    }

    if (isAdmin) {
      // Admins are unscoped, but personal containers would otherwise pile up
      // one per coach in the admin screens. Opt back in with
      // `includePersonal=true`.
      if (!query.includePersonal) {
        conditions.push({ personalOwnerId: null });
      }
    } else {
      const ids = await getReadableLeagueIds(caller.id);
      if (ids.length === 0) {
        return { leagues: [], total: 0, limit: query.limit, offset: query.offset };
      }
      conditions.push({ id: { in: ids } });
    }

    const where: Prisma.LeagueWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    // Get total count and leagues in parallel
    const [total, rows] = await Promise.all([
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

    // `personalOwnerId` never leaves the server; clients get the derived flag.
    // Note it is `!== null`, not `=== caller.id`: an ADMIN listing everyone's
    // leagues must still see another coach's container labelled personal.
    const leagues: LeagueListItem[] = rows.map(({ personalOwnerId, ...rest }) => ({
      ...rest,
      isPersonal: personalOwnerId !== null,
    }));

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
      omit: LEAGUE_OMIT,
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
   * @param userId User ID making the request (must be a system admin)
   */
  static async addLeagueAdmin(
    leagueId: string,
    adminUserId: string,
    userId: string
  ): Promise<LeagueAdminWithUser> {
    // System ADMIN only (decision 3). Existing league admins could previously
    // grant the role to anyone; delegated league administration is not a
    // product decision yet, so it is symmetric with removeLeagueAdmin for now.
    const isSysAdmin = await isSystemAdmin(userId);
    if (!isSysAdmin) {
      throw new ForbiddenError('Only system administrators can manage league admins');
    }

    const league = await prisma.league.findUnique({ where: { id: leagueId }, select: { id: true } });
    if (!league) {
      throw new NotFoundError('League not found');
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

    // Delete admin (404 rather than a Prisma P2025 → 500 when no such row)
    const { count } = await prisma.leagueAdmin.deleteMany({
      where: { leagueId, userId: adminUserId },
    });

    if (count === 0) {
      throw new NotFoundError('League admin not found');
    }

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
