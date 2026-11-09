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
import { logger } from '../utils/logger';
import { createOrConflict } from '../utils/prisma-errors';
import { USER_SUMMARY_SELECT, USER_SUMMARY_WITH_EMAIL_SELECT } from '../utils/user-select';

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
          // Staff emails go to every reader of the team (authorization.md).
          user: { select: USER_SUMMARY_WITH_EMAIL_SELECT },
          role: true,
        },
      },
      members: {
        include: {
          player: { select: USER_SUMMARY_SELECT },
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
  /**
   * Only when the query names a `leagueId`: whether the caller may create a
   * season there (`isLeagueAdmin`, the `POST /seasons` rule; a personal-league
   * owner holds that row). The rollover form (#461) offers "new season" on it.
   * A hint for the client; `POST /seasons` and the rollover stay the authority.
   */
  canCreate?: boolean;
}

/**
 * 400 body for a season whose name an existing season of the league already
 * has, matched ignoring case and surrounding spaces (#461). 400 is the
 * create endpoints' documented duplicate status since #727.
 */
export const SEASON_NAME_TAKEN_MESSAGE = 'A season with this name already exists in this league';

/**
 * The stored form of a season name: surrounding whitespace removed, exactly
 * as zod's `.trim()` does on the create schema (`createSeasonSchema`). Every
 * create path stores this, and `findSeasonByName` compares against it.
 */
export function normalizeSeasonName(name: string): string {
  return name.trim();
}

/** A season as the name rule and the rollover (#461) read it. */
export interface SeasonByName {
  id: string;
  isActive: boolean;
  startDate: Date | null;
  createdAt: Date;
}

/**
 * The season in `leagueId` whose name matches `name` ignoring case and
 * surrounding whitespace, or null. The ONE definition of "this league already
 * has that season": `findOrCreateSeason` (every season create path, the
 * personal-league provisioning included), the season rollover (#461) and the
 * season rename (`SeasonService.updateSeason`, #1008) read it. The rename
 * passes `excludeSeasonId`, its own id, so "fall 2026" may become "Fall
 * 2026" while another season's variant is still refused.
 *
 * The input is normalized in JS (`normalizeSeasonName`, zod's trim). The
 * stored side strips leading and trailing whitespace with `regexp_replace`
 * on `\s` (all whitespace, not just spaces as SQL `trim()` would), so rows
 * written before names were normalized still match. Raw SQL on purpose:
 * Prisma's `mode: 'insensitive'` compiles to an unescaped ILIKE (see
 * `utils/email-match.ts`), and an equality has no wildcard to escape. Oldest
 * first when near-duplicates already exist (there is no migration).
 */
export async function findSeasonByName(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  leagueId: string,
  name: string,
  excludeSeasonId?: string
): Promise<SeasonByName | null> {
  const rows = await db.$queryRaw<SeasonByName[]>`
    SELECT "id", "isActive", "startDate", "createdAt" FROM "Season"
    WHERE "leagueId" = ${leagueId}
      AND lower(regexp_replace("name", '^\\s+|\\s+$', '', 'g')) = lower(${normalizeSeasonName(name)})
      ${excludeSeasonId === undefined ? Prisma.empty : Prisma.sql`AND "id" <> ${excludeSeasonId}`}
    ORDER BY "createdAt" ASC
    LIMIT 1`;
  return rows[0] ?? null;
}

export interface NewSeason {
  leagueId: string;
  name: string;
  startDate?: Date | null;
  endDate?: Date | null;
}

/**
 * The season of `leagueId` named `input.name` (ignoring case and surrounding
 * whitespace), creating it when there is none. Shared by `POST /seasons`,
 * `POST /leagues/:id/seasons` and the season rollover (#461), inside the
 * caller's transaction; authorization and date validation stay with the
 * caller.
 *
 * Takes `FOR NO KEY UPDATE` on the League row first, so two creates in one
 * league serialize and two case variants of a name can never both be
 * minted. The insert is `INSERT ... ON CONFLICT DO NOTHING` (`createMany`
 * with `skipDuplicates`) and the row is read back by its exact name, so a
 * writer that does not take the lock (the personal-league provisioning
 * upsert) meeting this one on the same name converges instead of raising a
 * P2002, which would abort the whole transaction. Logs `Season created` only
 * when this call inserted the row.
 */
export async function findOrCreateSeason(
  tx: Prisma.TransactionClient,
  input: NewSeason,
  userId: string
): Promise<{ id: string; created: boolean; isActive: boolean }> {
  await tx.$queryRaw`SELECT "id" FROM "League" WHERE "id" = ${input.leagueId} FOR NO KEY UPDATE`;

  const name = normalizeSeasonName(input.name);
  const existing = await findSeasonByName(tx, input.leagueId, name);
  if (existing) {
    return { id: existing.id, created: false, isActive: existing.isActive };
  }

  const inserted = await tx.season.createMany({
    data: [
      {
        leagueId: input.leagueId,
        name,
        startDate: input.startDate,
        endDate: input.endDate,
        isActive: true,
      },
    ],
    skipDuplicates: true,
  });
  const season = await tx.season.findUniqueOrThrow({
    where: { leagueId_name: { leagueId: input.leagueId, name } },
    select: { id: true, isActive: true },
  });
  const created = inserted.count === 1;
  if (created) {
    logger.info('Season created', { seasonId: season.id, leagueId: input.leagueId, userId });
  }
  return { id: season.id, created, isActive: season.isActive };
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

    // Validate date range if both dates provided
    if (data.startDate && data.endDate && data.startDate > data.endDate) {
      throw new BadRequestError('Start date must be before end date');
    }

    // One rule for every create path (`findOrCreateSeason`): a name that
    // matches an existing season ignoring case and surrounding spaces is
    // taken, 400 (the duplicate status since #727).
    const { id, created } = await prisma.$transaction((tx) =>
      findOrCreateSeason(
        tx,
        { leagueId: data.leagueId, name: data.name, startDate: data.startDate, endDate: data.endDate },
        userId
      )
    );
    if (!created) {
      throw new BadRequestError(SEASON_NAME_TAKEN_MESSAGE);
    }

    const season = await prisma.season.findUniqueOrThrow({ where: { id }, include: SEASON_INCLUDE });

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
      // An explicit leagueId names the league the caller wants, personal or
      // not (the rollover form, #461, lists a coach's personal league); the
      // default hiding is only for the unfiltered admin listing.
      if (!query.includePersonal && !query.leagueId) {
        conditions.push({ league: { personalOwnerId: null } });
      }
    } else {
      const ids = await getReadableLeagueIds(caller.id);
      if (ids.length === 0) {
        return {
          seasons: [],
          total: 0,
          limit: query.limit,
          offset: query.offset,
          ...(query.leagueId ? { canCreate: false } : {}),
        };
      }
      conditions.push({ leagueId: { in: ids } });
    }

    const where: Prisma.SeasonWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    // Count, page and (for a leagueId filter) the create hint in parallel. A
    // caller who cannot read the league learns nothing from `canCreate:
    // false`; the list is already empty for them.
    const [total, seasons, canCreate] = await Promise.all([
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
      query.leagueId ? isLeagueAdmin(caller.id, query.leagueId) : Promise.resolve(undefined),
    ]);

    return {
      seasons,
      total,
      limit: query.limit,
      offset: query.offset,
      ...(canCreate !== undefined ? { canCreate } : {}),
    };
  }

  /**
   * Update a season.
   *
   * A rename follows the season name rule (#461, #1008): the new name is
   * stored trimmed (`normalizeSeasonName`; `updateSeasonSchema` trims too)
   * and is taken when another season of the league matches it ignoring case
   * and surrounding whitespace, the same 400 the create paths answer. The
   * check and the update run in one transaction under the League row lock
   * `findOrCreateSeason` takes, so a rename and a concurrent create cannot
   * both land on case variants of one name. A season may be renamed to a
   * variant of its own name. The exact unique index is still the last word
   * for a writer that takes no lock (the personal-league provisioning
   * insert): `createOrConflict` maps that P2002 to the same 400.
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

    const newName = data.name === undefined ? undefined : normalizeSeasonName(data.name);
    if (newName !== undefined) {
      updateData.name = newName;
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

    const update = (tx: Prisma.TransactionClient): Promise<SeasonWithTeams> =>
      tx.season.update({ where: { id: seasonId }, data: updateData, include: SEASON_INCLUDE });

    const updatedSeason =
      newName === undefined
        ? await update(prisma)
        : await prisma.$transaction(async (tx) => {
            // The lock `findOrCreateSeason` takes: a rename and a create in
            // one league serialize, so neither lands on a variant of the
            // other's name.
            await tx.$queryRaw`SELECT "id" FROM "League" WHERE "id" = ${season.leagueId} FOR NO KEY UPDATE`;
            const taken = await findSeasonByName(tx, season.leagueId, newName, seasonId);
            if (taken) {
              throw new BadRequestError(SEASON_NAME_TAKEN_MESSAGE);
            }
            return createOrConflict(() => update(tx), SEASON_NAME_TAKEN_MESSAGE, 'Season_leagueId_name_key');
          });

    logger.info('Season updated', { seasonId, leagueId: season.leagueId, userId });

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

    logger.info('Season deleted', { seasonId, leagueId: season.leagueId, userId });

    return { success: true };
  }
}
