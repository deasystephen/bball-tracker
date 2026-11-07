/**
 * Unit tests for `TeamService.rolloverTeam` (#461, season rollover).
 *
 * The permission helpers are spied so each test states the caller's standing
 * directly; the real Postgres behaviour (unique index, locks, case-insensitive
 * season match, career view) is in `tests/integration/team-rollover.db.test.ts`.
 */

jest.mock('../../src/services/usage-service', () => ({
  ...jest.requireActual('../../src/services/usage-service'),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

import * as permissions from '../../src/utils/permissions';
import { invalidateUsage } from '../../src/services/usage-service';
import { TeamService, SEASON_SIBLING_MESSAGE, isSeasonAfter } from '../../src/services/team-service';
import { logger } from '../../src/utils/logger';
import { USAGE_LIMITS } from '../../src/services/entitlements';
import { domainEvent, spyOnInfo } from '../support/domain-events';
import { mockPrisma } from '../setup';
import { uniqueViolation } from '../factories';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  NotLatestSeasonError,
  SeasonArchivedError,
  SeasonNotAfterSourceError,
  TeamSeasonExistsError,
} from '../../src/utils/errors';

const USER = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const ASSISTANT = 'b1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEAM = 'c1b2c3d4-e5f6-4890-a234-567890abcdef';
const NEW_TEAM = 'd1b2c3d4-e5f6-4890-a234-567890abcdef';
const LINEAGE = 'e1b2c3d4-e5f6-4890-a234-567890abcdef';
const LEAGUE = 'f1b2c3d4-e5f6-4890-a234-567890abcdef';
const SEASON = 'a2b2c3d4-e5f6-4890-a234-567890abcdef';
const NEXT_SEASON = 'a3b2c3d4-e5f6-4890-a234-567890abcdef';
const PLAYER = 'a4b2c3d4-e5f6-4890-a234-567890abcdef';

const HEAD_ROLE = {
  type: 'HEAD_COACH',
  name: 'Head Coach',
  description: null,
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};
const CUSTOM_ROLE = { ...HEAD_ROLE, type: 'CUSTOM', name: 'Scorekeeper', canManageTeam: false, canManageRoster: false };

/** The source team-season as read behind the row lock. */
const SOURCE_STARTS = new Date('2026-01-01T00:00:00Z');
const NEXT_STARTS = new Date('2027-01-01T00:00:00Z');
const OLDER_STARTS = new Date('2025-01-01T00:00:00Z');
const SOURCE = {
  name: 'Hawks',
  seasonId: SEASON,
  season: { leagueId: LEAGUE, startDate: SOURCE_STARTS, createdAt: SOURCE_STARTS },
  lineageId: LINEAGE,
  chatLink: 'https://chat.example.test/hawks',
  ageGroup: 'U12',
  gender: 'GIRLS',
  roles: [HEAD_ROLE, CUSTOM_ROLE],
  staff: [
    { userId: USER, role: { name: 'Head Coach' } },
    { userId: ASSISTANT, role: { name: 'Scorekeeper' } },
  ],
  members: [{ playerId: PLAYER, jerseyNumber: 0, position: 'PG' }],
};

const spies: Record<string, jest.SpyInstance> = {};

/** Run `body` with a finite FREE team cap of 1, put back afterwards. */
async function withLimit(body: () => Promise<void>): Promise<void> {
  const replaced = jest.replaceProperty(USAGE_LIMITS, 'FREE', { maxTeams: 1, maxSeasons: Infinity });
  try {
    await body();
  } finally {
    replaced.restore();
  }
}

type SeasonRow = { id: string; isActive: boolean; startDate?: Date | null; createdAt?: Date };

/** A season row as the name lookup returns it; next year's and active unless told otherwise. */
function seasonRow(id: string, over: Partial<SeasonRow> = {}): Required<SeasonRow> {
  return { id, isActive: true, startDate: NEXT_STARTS, createdAt: NEXT_STARTS, ...over } as Required<SeasonRow>;
}

/**
 * Raw statements by what they touch:
 * - the season-name lookups answer `seasonRows` in order (the rollover's own
 *   lookup, then `findOrCreateSeason`'s behind the League lock);
 * - a picked season's share lock answers `pickedSeason` (default: active, in LEAGUE);
 * - `lockUsers` returns every id it was asked for, tombstoned per `tombstones`;
 * - the team lock finds the team unless `teamLocked` is false.
 */
function mockRaw(
  options: {
    seasonRows?: Array<SeasonRow[]>;
    teamLocked?: boolean;
    tombstones?: string[];
    pickedSeason?: { leagueId: string; isActive: boolean; startDate?: Date | null; createdAt?: Date } | null;
  } = {}
): void {
  const seasonRows = [...(options.seasonRows ?? [[], []])];
  (mockPrisma.$queryRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('FROM "Season"') && sql.includes('FOR KEY SHARE')) {
      const picked =
        options.pickedSeason === undefined ? { leagueId: LEAGUE, isActive: true } : options.pickedSeason;
      return Promise.resolve(picked ? [{ startDate: NEXT_STARTS, createdAt: NEXT_STARTS, ...picked }] : []);
    }
    if (sql.includes('FROM "Season"')) return Promise.resolve(seasonRows.shift() ?? []);
    if (sql.includes('FROM "User"')) {
      const ids = (values[0] as { values: string[] }).values;
      return Promise.resolve(
        ids.map((id) => ({ id, deletedAt: options.tombstones?.includes(id) ? new Date() : null }))
      );
    }
    if (sql.includes('FROM "Team"')) return Promise.resolve(options.teamLocked === false ? [] : [{ id: TEAM }]);
    return Promise.resolve([{ id: 'locked' }]);
  });
}

/** `team.findUnique` by query shape: the 404 read, the carried read, the sibling probe, the final read. */
function mockTeamReads(sibling: { id: string } | null = null, finalRead = true): void {
  (mockPrisma.team.findUnique as jest.Mock).mockImplementation(
    (args: { where: Record<string, unknown>; include?: unknown; select?: Record<string, unknown> }) => {
      if (args.where.lineageId_seasonId) return Promise.resolve(sibling);
      if (args.select?.members) {
        return Promise.resolve({
          lineageId: LINEAGE,
          season: { leagueId: LEAGUE },
          staff: SOURCE.staff.map((row) => ({ userId: row.userId })),
          members: SOURCE.members.map((row) => ({ playerId: row.playerId })),
        });
      }
      if (args.include) {
        return Promise.resolve(finalRead ? { id: args.where.id, seasonId: NEXT_SEASON, staff: [], members: [] } : null);
      }
      return Promise.resolve({ id: TEAM });
    }
  );
}

/** The lineage's latest team-season (`team.findFirst`, newest row first). */
function mockLatest(id: string): void {
  (mockPrisma.team.findFirst as jest.Mock).mockResolvedValue({ id });
}

/** The SQL text of every raw statement, in call order. */
function rawStatements(): string[] {
  return (mockPrisma.$queryRaw as jest.Mock).mock.calls.map(([strings]) => (strings as TemplateStringsArray).join('?'));
}

beforeEach(() => {
  spies.canManageStaff = jest.spyOn(permissions, 'canManageStaff').mockResolvedValue(true);
  spies.isLeagueAdmin = jest.spyOn(permissions, 'isLeagueAdmin').mockResolvedValue(true);
  spies.hasTeamPermission = jest.spyOn(permissions, 'hasTeamPermission').mockResolvedValue(true);
  mockRaw();
  mockTeamReads();
  mockLatest(TEAM);
  (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue(SOURCE);
  (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 1 });
  (mockPrisma.season.findUniqueOrThrow as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, isActive: true });
  (mockPrisma.team.create as jest.Mock).mockResolvedValue({ id: NEW_TEAM });
  (mockPrisma.teamRole.createManyAndReturn as jest.Mock).mockResolvedValue([
    { id: 'new-head', name: 'Head Coach' },
    { id: 'new-custom', name: 'Scorekeeper' },
  ]);
  (mockPrisma.teamStaff.createMany as jest.Mock).mockResolvedValue({ count: 2 });
  (mockPrisma.teamMember.createMany as jest.Mock).mockResolvedValue({ count: 1 });
});

afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  (mockPrisma.$queryRaw as jest.Mock).mockReset().mockResolvedValue([{ '?column?': 1 }]);
});

describe('TeamService.rolloverTeam', () => {
  it('creates the next team-season and copies roles, staff and roster, every decision behind the locks', async () => {
    const info = spyOnInfo();

    const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027', ageGroup: 'U13' }, USER);

    expect(result).toEqual({ team: expect.objectContaining({ id: NEW_TEAM }), created: true, seasonCreated: true });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    // Before the transaction only unlocked reads run (existence, then WHO).
    // Inside, the locks go Users -> League -> Team -> TeamLineage (the order
    // league and season deletes use), then the name lookup, then
    // findOrCreateSeason's own League lock and name re-check.
    const statements = rawStatements();
    expect(statements[0]).toMatch(/FROM "User".*ORDER BY "id".*FOR NO KEY UPDATE/s);
    expect(statements[1]).toMatch(/FROM "League".*FOR NO KEY UPDATE/s);
    expect(statements[2]).toMatch(/FROM "Team".*FOR NO KEY UPDATE/s);
    expect(statements[3]).toMatch(/FROM "TeamLineage".*FOR NO KEY UPDATE/s);
    expect(statements[4]).toContain('lower(regexp_replace("name", ');
    expect(statements[5]).toMatch(/FROM "League".*FOR NO KEY UPDATE/s);
    expect(statements[6]).toContain('lower(regexp_replace("name", ');
    const userLock = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][1] as { values: string[] };
    expect(userLock.values).toEqual([USER, ASSISTANT, PLAYER]);

    // WHO twice: unlocked before any lock, then through the transaction
    // behind the team lock. Creating a season needs league admin, also
    // through the transaction.
    expect(spies.canManageStaff).toHaveBeenCalledTimes(2);
    expect(spies.canManageStaff).toHaveBeenNthCalledWith(1, USER, TEAM);
    expect(spies.canManageStaff).toHaveBeenNthCalledWith(2, USER, TEAM, mockPrisma);
    expect(spies.isLeagueAdmin).toHaveBeenCalledWith(USER, LEAGUE, mockPrisma);

    // The latest-row rule: newest row first.
    expect(mockPrisma.team.findFirst).toHaveBeenCalledWith({
      where: { lineageId: LINEAGE },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });

    // The season is inserted ON CONFLICT DO NOTHING, then read back by name.
    expect(mockPrisma.season.createMany).toHaveBeenCalledWith({
      data: [{ leagueId: LEAGUE, name: '2027', isActive: true }],
      skipDuplicates: true,
    });
    expect(mockPrisma.team.create).toHaveBeenCalledWith({
      data: {
        name: 'Hawks',
        seasonId: NEXT_SEASON,
        lineageId: LINEAGE,
        chatLink: SOURCE.chatLink,
        ageGroup: 'U13',
        gender: 'GIRLS',
      },
      select: { id: true },
    });
    expect(mockPrisma.teamRole.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        { ...HEAD_ROLE, teamId: NEW_TEAM },
        { ...CUSTOM_ROLE, teamId: NEW_TEAM },
      ],
      select: { id: true, name: true },
    });
    expect(mockPrisma.teamStaff.createMany).toHaveBeenCalledWith({
      data: [
        { teamId: NEW_TEAM, userId: USER, roleId: 'new-head' },
        { teamId: NEW_TEAM, userId: ASSISTANT, roleId: 'new-custom' },
      ],
    });
    expect(mockPrisma.teamMember.createMany).toHaveBeenCalledWith({
      data: [{ teamId: NEW_TEAM, playerId: PLAYER, jerseyNumber: 0, position: 'PG' }],
    });

    // The source is re-read behind the lock, tombstones filtered there.
    const sourceRead = (mockPrisma.team.findUniqueOrThrow as jest.Mock).mock.calls[0][0];
    expect(sourceRead.where).toEqual({ id: TEAM });
    expect(sourceRead.select.staff.where).toEqual({ user: { deletedAt: null } });
    expect(sourceRead.select.members.where).toEqual({ player: { deletedAt: null } });

    // Nothing season-bound is carried, and the source row is never written.
    expect(mockPrisma.team.update).not.toHaveBeenCalled();
    expect(mockPrisma.teamInvitation.create).not.toHaveBeenCalled();
    expect(mockPrisma.calendarFeedToken.create).not.toHaveBeenCalled();
    expect(mockPrisma.announcement.create).not.toHaveBeenCalled();

    expect(domainEvent(info, 'Team rolled over')).toEqual({
      teamId: NEW_TEAM,
      fromTeamId: TEAM,
      lineageId: LINEAGE,
      fromSeasonId: SEASON,
      toSeasonId: NEXT_SEASON,
      seasonCreated: true,
      members: 1,
      staff: 2,
      userId: USER,
    });
    expect(domainEvent(info, 'Season created')).toEqual({ seasonId: NEXT_SEASON, leagueId: LEAGUE, userId: USER });
    expect(invalidateUsage).toHaveBeenCalledWith(USER, USER, ASSISTANT);
  });

  it('rolls into a picked active season, carrying the bracket and name unless overridden; null clears', async () => {
    await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON, name: 'Hawks 2027', gender: null }, USER);

    expect(rawStatements().some((sql) => sql.includes('FOR KEY SHARE'))).toBe(true);
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(spies.isLeagueAdmin).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Hawks 2027', seasonId: NEXT_SEASON, ageGroup: 'U12', gender: null }),
      select: { id: true },
    });
  });

  it('matches an existing season by name ignoring case and spaces, without needing league admin', async () => {
    mockRaw({ seasonRows: [[seasonRow(NEXT_SEASON)]] });
    spies.isLeagueAdmin.mockResolvedValue(false);

    await TeamService.rolloverTeam(TEAM, { seasonName: 'spring 2025' }, USER);

    const lookup = (mockPrisma.$queryRaw as jest.Mock).mock.calls.find(([st]) =>
      (st as TemplateStringsArray).join('?').includes('lower(regexp_replace("name"')
    ) as [TemplateStringsArray, ...unknown[]];
    expect(lookup.slice(1)).toEqual([LEAGUE, 'spring 2025']);
    expect(spies.isLeagueAdmin).not.toHaveBeenCalled();
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seasonId: NEXT_SEASON }) })
    );
  });

  it('refuses a non-admin with 403 when the name resolves to nothing behind the locks, creating nothing', async () => {
    // Whatever the client saw a moment ago (the season existed), the decision
    // is the one made inside the transaction: no season by that name now.
    mockRaw({ seasonRows: [[]] });
    spies.isLeagueAdmin.mockResolvedValue(false);
    const info = spyOnInfo();

    await expect(TeamService.rolloverTeam(TEAM, { seasonName: 'Spring 2025' }, USER)).rejects.toThrow(
      'You do not have permission to create seasons for this league'
    );

    expect(spies.isLeagueAdmin).toHaveBeenCalledWith(USER, LEAGUE, mockPrisma);
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).not.toHaveBeenCalled();
    expect(info.mock.calls.filter(([msg]) => msg === 'Team rolled over')).toHaveLength(0);
  });

  it('reuses a season a concurrent create made between the lookup and the League lock', async () => {
    mockRaw({ seasonRows: [[], [seasonRow(NEXT_SEASON)]] });

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seasonId: NEXT_SEASON }) })
    );
  });

  it('reuses a season a concurrent POST /seasons created under the same name (ON CONFLICT DO NOTHING)', async () => {
    (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 0 });
    const info = spyOnInfo();

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seasonId: NEXT_SEASON }) })
    );
    expect(domainEvent(info, 'Team rolled over')).toEqual(expect.objectContaining({ seasonCreated: false }));
  });

  describe('archived seasons (409 season_archived, no ids)', () => {
    it('refuses a named season that matches an archived one', async () => {
      mockRaw({ seasonRows: [[seasonRow(NEXT_SEASON, { isActive: false })]] });

      const err = await TeamService.rolloverTeam(TEAM, { seasonName: 'spring 2023' }, USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SeasonArchivedError);
      expect((err as SeasonArchivedError).body()).toEqual({
        error: 'That season is archived; pick or name an active season',
        code: 'season_archived',
      });
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('refuses a picked season that is archived', async () => {
      mockRaw({ pickedSeason: { leagueId: LEAGUE, isActive: false } });

      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toBeInstanceOf(
        SeasonArchivedError
      );
    });

    it('refuses when an archived season of that name appears behind the League lock', async () => {
      (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 0 });
      mockRaw({ seasonRows: [[], [seasonRow(NEXT_SEASON, { isActive: false })]] });

      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(
        SeasonArchivedError
      );
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });
  });

  it('skips the staff and roster inserts when there is nothing to carry', async () => {
    (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...SOURCE, staff: [], members: [] });

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.teamStaff.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.teamMember.createMany).not.toHaveBeenCalled();
  });

  it('carries only users that are live once locked: a tombstone is not carried', async () => {
    mockRaw({ tombstones: [ASSISTANT, PLAYER] });

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.teamStaff.createMany).toHaveBeenCalledWith({
      data: [{ teamId: NEW_TEAM, userId: USER, roleId: 'new-head' }],
    });
    expect(mockPrisma.teamMember.createMany).not.toHaveBeenCalled();
  });

  it('does not carry a member who appeared after the unlocked read (not in the locked set)', async () => {
    (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      ...SOURCE,
      members: [...SOURCE.members, { playerId: 'late-player', jerseyNumber: 7, position: null }],
    });

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.teamMember.createMany).toHaveBeenCalledWith({
      data: [{ teamId: NEW_TEAM, playerId: PLAYER, jerseyNumber: 0, position: 'PG' }],
    });
  });

  it('is not metered: even at a finite cap nothing counts the caller (a team is its lineage)', async () => {
    await withLimit(async () => {
      await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);
    });

    expect(mockPrisma.team.groupBy).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalled();
  });

  it('fails the whole rollover rather than drop a staff row whose role did not map', async () => {
    (mockPrisma.teamRole.createManyAndReturn as jest.Mock).mockResolvedValue([{ id: 'new-head', name: 'Head Coach' }]);

    await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow(
      'Rollover could not map a staff role onto the new team'
    );
    expect(mockPrisma.teamStaff.createMany).not.toHaveBeenCalled();
  });

  describe('when the lineage already has a row in that season', () => {
    beforeEach(() => {
      mockTeamReads({ id: NEW_TEAM });
      mockRaw({ seasonRows: [[seasonRow(NEXT_SEASON)]] });
    });

    it('returns it with created: false to a caller who may manage its roster, writing nothing', async () => {
      const info = spyOnInfo();
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);

      const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

      expect(result).toEqual({ team: expect.objectContaining({ id: NEW_TEAM }), created: false, seasonCreated: false });
      expect(spies.hasTeamPermission).toHaveBeenCalledWith(USER, NEW_TEAM, 'canManageRoster');
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
      expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
      expect(invalidateUsage).not.toHaveBeenCalled();
      // A no-op is not a domain event: debug, not info.
      expect(info.mock.calls.filter(([msg]) => msg === 'Team rolled over')).toHaveLength(0);
      expect(debug).toHaveBeenCalledWith(
        'Team rollover already done',
        expect.objectContaining({ teamId: NEW_TEAM, seasonCreated: false, members: 0, staff: 0 })
      );
      debug.mockRestore();
    });

    it('answers the existing row even when its season has since been archived (idempotency first)', async () => {
      mockRaw({ seasonRows: [[seasonRow(NEXT_SEASON, { isActive: false })]] });

      const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

      expect(result.created).toBe(false);
      expect(result.team.id).toBe(NEW_TEAM);
    });

    it("is idempotent from last season's row too: a repeat after the rollover returns the same row", async () => {
      // The source is no longer the latest (the new row is), but the answer
      // is the existing row, before the latest-row rule applies.
      mockLatest(NEW_TEAM);

      const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

      expect(result.created).toBe(false);
      expect(result.team.id).toBe(NEW_TEAM);
    });

    it('answers 409 with no id to a caller who cannot manage it, and logs nothing at info', async () => {
      spies.hasTeamPermission.mockResolvedValue(false);
      const info = spyOnInfo();

      const err = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TeamSeasonExistsError);
      expect((err as TeamSeasonExistsError).body()).toEqual({
        error: 'This team already has a team-season in that season',
        code: 'team_season_exists',
      });
      expect(info.mock.calls.filter(([msg]) => msg === 'Team rolled over')).toHaveLength(0);
      // The full row is never read for this caller.
      expect(
        (mockPrisma.team.findUnique as jest.Mock).mock.calls.some(([args]) => (args as { include?: unknown }).include)
      ).toBe(false);
    });
  });

  describe("only the lineage's latest team-season may start the next one", () => {
    it('answers 409 not_latest_season with no ids from an older row, creating nothing', async () => {
      mockLatest(NEW_TEAM);

      const err = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NotLatestSeasonError);
      expect((err as NotLatestSeasonError).body()).toEqual({
        error: "Only the team's most recent season can start the next one",
        code: 'not_latest_season',
      });
      expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('refuses a picked season the same way when the lineage has no row in it', async () => {
      mockLatest(NEW_TEAM);

      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toBeInstanceOf(
        NotLatestSeasonError
      );
    });
  });

  describe('the target season must start after the source season when both are dated (400 season_not_after_source)', () => {
    it('refuses a picked season that starts before the source season', async () => {
      mockRaw({ pickedSeason: { leagueId: LEAGUE, isActive: true, startDate: OLDER_STARTS } });

      const err = await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SeasonNotAfterSourceError);
      expect((err as SeasonNotAfterSourceError).body()).toEqual({
        error: "The next season must come after the team's current season",
        code: 'season_not_after_source',
      });
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('allows an undated season, whenever it was created (nothing to order by)', async () => {
      mockRaw({ seasonRows: [[seasonRow(NEXT_SEASON, { startDate: null, createdAt: OLDER_STARTS })]] });

      await expect(TeamService.rolloverTeam(TEAM, { seasonName: 'Next' }, USER)).resolves.toMatchObject({
        created: true,
      });
    });

    it('allows any season when the source season is undated', async () => {
      (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...SOURCE,
        season: { ...SOURCE.season, startDate: null },
      });
      mockRaw({ pickedSeason: { leagueId: LEAGUE, isActive: true, startDate: OLDER_STARTS } });

      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).resolves.toMatchObject({
        created: true,
      });
    });

    it('isSeasonAfter: strictly later start when both are dated; otherwise allowed', () => {
      const at = (iso: string): Date => new Date(iso);
      expect(isSeasonAfter({ startDate: at('2027-01-01') }, { startDate: at('2026-01-01') })).toBe(true);
      expect(isSeasonAfter({ startDate: at('2026-01-01') }, { startDate: at('2026-01-01') })).toBe(false);
      expect(isSeasonAfter({ startDate: at('2025-01-01') }, { startDate: at('2026-01-01') })).toBe(false);
      expect(isSeasonAfter({ startDate: null }, { startDate: at('2030-01-01') })).toBe(true);
      expect(isSeasonAfter({ startDate: at('2020-01-01') }, { startDate: null })).toBe(true);
    });
  });

  describe('refusals', () => {
    it('404s an unknown team at the cheap read, before any transaction', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(NotFoundError);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s when the source team is gone at the carried read', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockImplementation((args: { select?: Record<string, unknown> }) =>
        Promise.resolve(args.select?.members ? null : { id: TEAM })
      );
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow('Team not found');
    });

    it('404s when the source team is deleted before the lock is taken', async () => {
      mockRaw({ teamLocked: false });
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow('Team not found');
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('403s a caller who cannot manage staff (an assistant coach) before taking any lock, logging nothing', async () => {
      spies.canManageStaff.mockResolvedValue(false);
      const info = spyOnInfo();

      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, ASSISTANT)).rejects.toThrow(
        'Only a head coach can start the next season for this team'
      );
      expect(spies.canManageStaff).toHaveBeenCalledTimes(1);
      expect(spies.canManageStaff).toHaveBeenCalledWith(ASSISTANT, TEAM);
      // No transaction, so no User, League, Team or lineage lock was taken.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(info.mock.calls.filter(([msg]) => msg === 'Team rolled over')).toHaveLength(0);
    });

    it('403s when the caller lost head coach between the unlocked check and the team lock', async () => {
      spies.canManageStaff.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(spies.canManageStaff).toHaveBeenLastCalledWith(USER, TEAM, mockPrisma);
      expect(mockPrisma.team.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('400s when the team moved to another league between the unlocked read and the team lock', async () => {
      (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...SOURCE,
        season: { ...SOURCE.season, leagueId: 'moved' },
      });

      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow(
        'This team moved to another league; reload it and try again'
      );
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('404s an unknown seasonId, and one in another league the same way (ids cannot be probed)', async () => {
      mockRaw({ pickedSeason: null });
      const missing = await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER).catch((e: unknown) => e);

      mockRaw({ pickedSeason: { leagueId: 'other-league', isActive: true } });
      const foreign = await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER).catch((e: unknown) => e);

      expect(missing).toBeInstanceOf(NotFoundError);
      expect(foreign).toBeInstanceOf(NotFoundError);
      expect((foreign as Error).message).toBe((missing as Error).message);
      expect((missing as Error).message).toBe('Season not found');
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it("400s the team's own season", async () => {
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: SEASON }, USER)).rejects.toThrow(
        'The team is already in that season'
      );
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('maps a P2002 on the lineage/season unique to the season-move 400', async () => {
      (mockPrisma.team.create as jest.Mock).mockRejectedValue(uniqueViolation('Team_lineageId_seasonId_key'));
      const err = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as Error).message).toBe(SEASON_SIBLING_MESSAGE);
    });

    it('rethrows a P2002 on any other unique', async () => {
      const other = uniqueViolation('TeamMember_teamId_playerId_key');
      (mockPrisma.teamMember.createMany as jest.Mock).mockRejectedValue(other);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBe(other);
    });

    it('404s when the new row has vanished before the final read, logging nothing', async () => {
      mockTeamReads(null, false);
      const info = spyOnInfo();
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(NotFoundError);
      expect(info.mock.calls.filter(([msg]) => msg === 'Team rolled over')).toHaveLength(0);
    });

    it('surfaces a Forbidden from the WHO check as-is', async () => {
      spies.canManageStaff.mockResolvedValue(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toBeInstanceOf(
        ForbiddenError
      );
    });
  });
});
