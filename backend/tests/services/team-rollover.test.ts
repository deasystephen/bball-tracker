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
import { TeamService, SEASON_SIBLING_MESSAGE } from '../../src/services/team-service';
import { domainEvent, spyOnInfo } from '../support/domain-events';
import { mockPrisma } from '../setup';
import { uniqueViolation } from '../factories';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  TeamSeasonExistsError,
  NotLatestSeasonError,
} from '../../src/utils/errors';
import { USAGE_LIMITS } from '../../src/services/entitlements';

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
const SOURCE = {
  name: 'Hawks',
  seasonId: SEASON,
  season: { leagueId: LEAGUE },
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

/**
 * Raw statements by what they touch:
 * - the season-name lookups answer `seasonRows` in order (pre-check outside
 *   the transaction, the in-transaction lookup, `findOrCreateSeason`'s);
 * - the picked-season share lock answers `pickedSeason` (default: in LEAGUE);
 * - `lockUsers` returns every id it was asked for, tombstoned per `tombstones`;
 * - the latest-row query answers `latest` (default: the source team);
 * - the team lock finds the team unless `teamLocked` is false.
 */
function mockRaw(
  options: {
    seasonRows?: Array<{ id: string }[]>;
    teamLocked?: boolean;
    tombstones?: string[];
    latest?: string;
    pickedSeason?: { leagueId: string } | null;
  } = {}
): void {
  const seasonRows = [...(options.seasonRows ?? [[], [], []])];
  (mockPrisma.$queryRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('JOIN "Season"')) return Promise.resolve([{ id: options.latest ?? TEAM }]);
    if (sql.includes('FROM "Season"') && sql.includes('FOR KEY SHARE')) {
      const picked = options.pickedSeason === undefined ? { leagueId: LEAGUE } : options.pickedSeason;
      return Promise.resolve(picked ? [picked] : []);
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

/** `team.findUnique` by query shape: the pre-check read, the sibling probe and the final read. */
function mockTeamReads(sibling: { id: string } | null = null, finalRead = true): void {
  (mockPrisma.team.findUnique as jest.Mock).mockImplementation(
    (args: { where: Record<string, unknown>; include?: unknown }) => {
      if (args.where.lineageId_seasonId) return Promise.resolve(sibling);
      const select = (args as { select?: Record<string, unknown> }).select;
      if (select?.members) {
        // The unlocked "who would be carried" read.
        return Promise.resolve({
          staff: SOURCE.staff.map((row) => ({ userId: row.userId })),
          members: SOURCE.members.map((row) => ({ playerId: row.playerId })),
        });
      }
      if (args.include) {
        return Promise.resolve(finalRead ? { id: args.where.id, seasonId: NEXT_SEASON, staff: [], members: [] } : null);
      }
      return Promise.resolve({ id: TEAM, lineageId: LINEAGE, season: { leagueId: LEAGUE } });
    }
  );
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
  (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue(SOURCE);
  (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 1 });
  (mockPrisma.season.findUniqueOrThrow as jest.Mock).mockResolvedValue({ id: NEXT_SEASON });
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
  it('creates the next team-season and copies roles, staff and roster behind its locks', async () => {
    const info = spyOnInfo();

    const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027', ageGroup: 'U13' }, USER);

    expect(result).toEqual({ team: expect.objectContaining({ id: NEW_TEAM }), created: true });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    // Lock order: every User the copy references (in id order, before the
    // team, the order account deletion uses), the source Team row, the
    // lineage, the name lookup, the latest-row rule, then (to create a
    // season) the league through findOrCreateSeason.
    const statements = rawStatements();
    expect(statements[0]).toContain('FROM "Season"'); // pre-check lookup, outside the transaction
    expect(statements[1]).toMatch(/FROM "User".*ORDER BY "id".*FOR NO KEY UPDATE/s);
    expect(statements[2]).toMatch(/FROM "Team".*FOR NO KEY UPDATE/s);
    expect(statements[3]).toMatch(/FROM "TeamLineage".*FOR NO KEY UPDATE/s);
    expect(statements[4]).toContain('lower(trim("name")) = lower(trim(');
    expect(statements[5]).toMatch(/JOIN "Season".*ORDER BY COALESCE\(s."startDate", s."createdAt"\) DESC/s);
    expect(statements[6]).toMatch(/FROM "League".*FOR NO KEY UPDATE/s);
    expect(statements[7]).toContain('lower(trim("name")) = lower(trim(');
    const userLock = (mockPrisma.$queryRaw as jest.Mock).mock.calls[1][1] as { values: string[] };
    expect(userLock.values).toEqual([USER, ASSISTANT, PLAYER]);

    // WHO again behind the team lock, read through the transaction.
    expect(spies.canManageStaff).toHaveBeenCalledTimes(2);
    expect(spies.canManageStaff).toHaveBeenLastCalledWith(USER, TEAM, mockPrisma);

    // The season is inserted ON CONFLICT DO NOTHING, then read back by name.
    expect(mockPrisma.season.createMany).toHaveBeenCalledWith({
      data: [{ leagueId: LEAGUE, name: '2027', isActive: true }],
      skipDuplicates: true,
    });
    expect(mockPrisma.season.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { leagueId_name: { leagueId: LEAGUE, name: '2027' } },
      select: { id: true },
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
      created: true,
      seasonCreated: true,
      members: 1,
      staff: 2,
      userId: USER,
    });
    expect(domainEvent(info, 'Season created')).toEqual({ seasonId: NEXT_SEASON, leagueId: LEAGUE, userId: USER });
    expect(invalidateUsage).toHaveBeenCalledWith(USER, USER, ASSISTANT);
  });

  it('carries the bracket and name unchanged when the body leaves them out, and clears on null', async () => {
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, leagueId: LEAGUE });

    await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON, name: 'Hawks 2027', gender: null }, USER);

    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(rawStatements().some((sql) => sql.includes('FROM "League"'))).toBe(false);
    expect(mockPrisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Hawks 2027', seasonId: NEXT_SEASON, ageGroup: 'U12', gender: null }),
      select: { id: true },
    });
  });

  it('matches an existing season by name ignoring case and spaces, without needing league admin', async () => {
    mockRaw({ seasonRows: [[{ id: NEXT_SEASON }]] });
    spies.isLeagueAdmin.mockResolvedValue(false);

    await TeamService.rolloverTeam(TEAM, { seasonName: 'spring 2025' }, USER);

    const [strings, ...values] = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('lower(trim("name")) = lower(trim(');
    expect(values).toEqual([LEAGUE, 'spring 2025']);
    expect(spies.isLeagueAdmin).not.toHaveBeenCalled();
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seasonId: NEXT_SEASON }) })
    );
  });

  it('uses a season a concurrent request created between the pre-check and the league lock', async () => {
    mockRaw({ seasonRows: [[], [{ id: NEXT_SEASON }]] });

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seasonId: NEXT_SEASON }) })
    );
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

  it('reuses a season a concurrent POST /seasons created under the same name (ON CONFLICT DO NOTHING)', async () => {
    (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 0 });
    const info = spyOnInfo();

    await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seasonId: NEXT_SEASON }) })
    );
    expect(domainEvent(info, 'Team rolled over')).toEqual(expect.objectContaining({ seasonCreated: false }));
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
      mockRaw({ seasonRows: [[{ id: NEXT_SEASON }], [{ id: NEXT_SEASON }]] });
    });

    it('returns it with created: false to a caller who may manage its roster, writing nothing', async () => {
      const info = spyOnInfo();

      const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

      expect(result).toEqual({ team: expect.objectContaining({ id: NEW_TEAM }), created: false });
      expect(spies.hasTeamPermission).toHaveBeenCalledWith(USER, NEW_TEAM, 'canManageRoster');
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
      expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
      expect(invalidateUsage).not.toHaveBeenCalled();
      expect(domainEvent(info, 'Team rolled over')).toEqual(
        expect.objectContaining({ teamId: NEW_TEAM, created: false, seasonCreated: false, members: 0, staff: 0 })
      );
    });

    it('is idempotent from last season\'s row too: a repeat after the rollover returns the same row', async () => {
      // The source is no longer the latest (the new row is), but the answer
      // is the existing row, before the latest-row rule applies.
      mockRaw({ seasonRows: [[{ id: NEXT_SEASON }], [{ id: NEXT_SEASON }]], latest: NEW_TEAM });

      const result = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER);

      expect(result.created).toBe(false);
      expect(result.team.id).toBe(NEW_TEAM);
    });

    it('answers 409 with no id to a caller who cannot manage it (a coach removed from it)', async () => {
      spies.hasTeamPermission.mockResolvedValue(false);

      const err = await TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TeamSeasonExistsError);
      expect((err as TeamSeasonExistsError).body()).toEqual({
        error: 'This team already has a team-season in that season',
        code: 'team_season_exists',
      });
      // The full row is never read for this caller.
      expect(
        (mockPrisma.team.findUnique as jest.Mock).mock.calls.some(([args]) => (args as { include?: unknown }).include)
      ).toBe(false);
    });
  });

  describe("only the lineage's latest team-season may start the next one", () => {
    it('answers 409 not_latest_season with no ids from an older row, creating nothing', async () => {
      mockRaw({ latest: NEW_TEAM });

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
      mockRaw({ latest: NEW_TEAM });
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, leagueId: LEAGUE });

      await expect(
        TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)
      ).rejects.toBeInstanceOf(NotLatestSeasonError);
    });
  });

  describe('refusals', () => {
    it('404s an unknown team', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('404s when the source team is deleted before the lock is taken', async () => {
      mockRaw({ teamLocked: false });
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow('Team not found');
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('403s a caller who cannot manage staff (an assistant coach), before reading any season', async () => {
      spies.canManageStaff.mockResolvedValue(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, ASSISTANT)).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(mockPrisma.season.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('403s creating a new season without league admin', async () => {
      spies.isLeagueAdmin.mockResolvedValue(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow(
        'You do not have permission to create seasons for this league'
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('403s when the caller lost head coach between the first check and the team lock', async () => {
      spies.canManageStaff.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(
        ForbiddenError
      );
      expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('404s when the source team is gone at the unlocked carried read', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockImplementation((args: { select?: Record<string, unknown> }) =>
        Promise.resolve(args.select?.members ? null : { id: TEAM, lineageId: LINEAGE, season: { leagueId: LEAGUE } })
      );
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow('Team not found');
    });

    it('404s a picked season deleted or moved between the pre-check and the share lock', async () => {
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, leagueId: LEAGUE });

      mockRaw({ pickedSeason: null });
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toThrow('Season not found');

      mockRaw({ pickedSeason: { leagueId: 'elsewhere' } });
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toThrow('Season not found');
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('404s an unknown seasonId', async () => {
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER)).rejects.toThrow('Season not found');
    });

    it('404s a season in another league, exactly like an unknown one (ids cannot be probed)', async () => {
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON, leagueId: 'other-league' });
      const err = await TeamService.rolloverTeam(TEAM, { seasonId: NEXT_SEASON }, USER).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe('Season not found');
    });

    it("400s the team's own season (read behind the lock)", async () => {
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: SEASON, leagueId: LEAGUE });
      await expect(TeamService.rolloverTeam(TEAM, { seasonId: SEASON }, USER)).rejects.toThrow(
        'The team is already in that season'
      );
      expect(mockPrisma.team.create).not.toHaveBeenCalled();
    });

    it('400s when the team moved to another league between the checks and the lock', async () => {
      (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...SOURCE, season: { leagueId: 'moved' } });
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toThrow(
        'This team moved to another league; reload it and try again'
      );
      expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
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

    it('404s when the new row has vanished before the final read', async () => {
      mockTeamReads(null, false);
      await expect(TeamService.rolloverTeam(TEAM, { seasonName: '2027' }, USER)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
