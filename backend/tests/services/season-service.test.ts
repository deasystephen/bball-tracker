/**
 * Unit tests for SeasonService
 *
 * Covers permission gating (league admin / system admin), uniqueness,
 * date-range validation, and delete guards.
 */

import * as permissions from '../../src/utils/permissions';
import { SeasonService, findOrCreateSeason, findSeasonByName } from '../../src/services/season-service';
import { mockPrisma } from '../setup';
import { BadRequestError } from '../../src/utils/errors';
import {
  createAdmin,
  createCoach,
  createLeague,
  createPlayer,
  createSeason,
} from '../factories';
import { expectBadRequestError, expectForbiddenError, expectNotFoundError } from '../helpers';
import { domainEvent, spyOnInfo } from '../support/domain-events';

/** `$queryRaw`: the season-name lookup answers `rows`; the League lock finds its row. */
function mockSeasonRaw(rows: { id: string; isActive: boolean }[]): void {
  (mockPrisma.$queryRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve((strings as TemplateStringsArray).join('?').includes('FROM "Season"') ? rows : [{ id: 'league' }])
  );
}

afterEach(() => {
  (mockPrisma.$queryRaw as jest.Mock).mockReset().mockResolvedValue([{ '?column?': 1 }]);
});

describe('findSeasonByName / findOrCreateSeason (#461)', () => {
  it('normalizes the input (trim) and strips all whitespace around the stored name, ignoring case, oldest first', async () => {
    mockSeasonRaw([{ id: 'oldest', isActive: true }]);

    await expect(findSeasonByName(mockPrisma as never, 'league-1', ' Spring 2025 ')).resolves.toEqual({
      id: 'oldest',
      isActive: true,
    });

    const [strings, ...values] = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    // The regex reaches Postgres with its backslashes: all whitespace, not just spaces.
    expect(sql).toContain(`lower(regexp_replace("name", '^\\s+|\\s+$', '', 'g')) = lower(?)`);
    expect(sql).toContain('ORDER BY "createdAt" ASC');
    expect(values).toEqual(['league-1', 'Spring 2025']);
  });

  it('findOrCreateSeason stores the normalized (trimmed) name and reads it back by that name', async () => {
    mockSeasonRaw([]);
    (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.season.findUniqueOrThrow as jest.Mock).mockResolvedValue({ id: 's-new', isActive: true });

    await expect(
      findOrCreateSeason(mockPrisma as never, { leagueId: 'league-1', name: '\t Fall 2027 \n' }, 'u')
    ).resolves.toEqual({ id: 's-new', created: true, isActive: true });

    expect(mockPrisma.season.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ leagueId: 'league-1', name: 'Fall 2027', isActive: true })],
      skipDuplicates: true,
    });
    expect(mockPrisma.season.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { leagueId_name: { leagueId: 'league-1', name: 'Fall 2027' } },
      select: { id: true, isActive: true },
    });
  });

  it('answers null when nothing matches', async () => {
    mockSeasonRaw([]);
    await expect(findSeasonByName(mockPrisma as never, 'league-1', 'x')).resolves.toBeNull();
  });

  it('locks the League row before looking up, and returns an existing match without inserting', async () => {
    mockSeasonRaw([{ id: 'existing', isActive: true }]);

    await expect(findOrCreateSeason(mockPrisma as never, { leagueId: 'league-1', name: 'spring' }, 'u')).resolves.toEqual({
      id: 'existing',
      created: false,
      isActive: true,
    });

    const statements = (mockPrisma.$queryRaw as jest.Mock).mock.calls.map(([st]) => (st as TemplateStringsArray).join('?'));
    expect(statements[0]).toMatch(/FROM "League".*FOR NO KEY UPDATE/s);
    expect(statements[1]).toContain('FROM "Season"');
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
  });
});

describe('SeasonService', () => {
  describe('createSeason', () => {
    it('creates a season when caller is a league admin, through findOrCreateSeason', async () => {
      const admin = createAdmin();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id, name: 'Fall 2026' });

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      // isLeagueAdmin: first looks up user (admin role), short-circuits true
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      mockSeasonRaw([]);
      (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.season.findUniqueOrThrow as jest.Mock)
        .mockResolvedValueOnce({ id: season.id, isActive: true })
        .mockResolvedValueOnce(season);
      const info = spyOnInfo();

      const result = await SeasonService.createSeason(
        { leagueId: league.id, name: 'Fall 2026' },
        admin.id
      );

      expect(result.id).toBe(season.id);
      expect(mockPrisma.season.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ leagueId: league.id, name: 'Fall 2026', isActive: true })],
        skipDuplicates: true,
      });
      expect(domainEvent(info, 'Season created')).toEqual({ seasonId: season.id, leagueId: league.id, userId: admin.id });
    });

    it('throws NotFoundError when league does not exist', async () => {
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        SeasonService.createSeason(
          { leagueId: 'missing', name: 'X' },
          'user-1'
        )
      ).rejects.toMatchObject({ statusCode: 404, message: 'League not found' });
    });

    it('rejects non-admins with BadRequestError', async () => {
      const coach = createCoach();
      const league = createLeague();

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      // isSystemAdmin -> user lookup returns non-admin
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      // isLeagueAdmin falls through to leagueAdmin.findUnique -> null
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await SeasonService.createSeason(
          { leagueId: league.id, name: 'Fall' },
          coach.id
        );
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have permission to create seasons for this league');
      }
    });

    it('answers the duplicate-name 400 for a name an existing season has, ignoring case and surrounding spaces', async () => {
      const admin = createAdmin();
      const league = createLeague();

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      mockSeasonRaw([{ id: 'existing-fall', isActive: true }]);

      const error = await SeasonService.createSeason({ leagueId: league.id, name: ' fall ' }, admin.id).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestError);
      expect(error.message).toBe('A season with this name already exists in this league');
      expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
      const lookup = (mockPrisma.$queryRaw as jest.Mock).mock.calls.find(([strings]) =>
        (strings as TemplateStringsArray).join('?').includes('lower(regexp_replace("name"')
      );
      expect(lookup?.slice(1)).toEqual([league.id, 'fall']);
    });

    it('answers the duplicate-name 400 when a concurrent create of the exact name wins (ON CONFLICT DO NOTHING inserted nothing)', async () => {
      const admin = createAdmin();
      const league = createLeague();

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      mockSeasonRaw([]);
      (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.season.findUniqueOrThrow as jest.Mock).mockResolvedValue({ id: 'theirs', isActive: true });
      const info = spyOnInfo();

      const error = await SeasonService.createSeason({ leagueId: league.id, name: 'Fall' }, admin.id).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestError);
      expect(info.mock.calls.filter(([msg]) => msg === 'Season created')).toHaveLength(0);
    });

    it('propagates a season create failure', async () => {
      const admin = createAdmin();
      const league = createLeague();
      const boom = new Error('connection reset');

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      mockSeasonRaw([]);
      (mockPrisma.season.createMany as jest.Mock).mockRejectedValue(boom);

      await expect(SeasonService.createSeason({ leagueId: league.id, name: 'Fall' }, admin.id)).rejects.toBe(boom);
    });

    it('rejects inverted start/end dates', async () => {
      const admin = createAdmin();
      const league = createLeague();

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await SeasonService.createSeason(
          {
            leagueId: league.id,
            name: 'Weird',
            startDate: new Date('2026-12-01'),
            endDate: new Date('2026-01-01'),
          },
          admin.id
        );
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'Start date must be before end date');
      }
      expect(mockPrisma.season.create).not.toHaveBeenCalled();
    });
  });

  describe('getSeasonById', () => {
    it('returns metadata + team names only for an affiliated non-league-admin', async () => {
      const player = createPlayer();
      const season = createSeason();
      const summary = {
        ...season,
        league: { id: season.leagueId, name: 'L' },
        teams: [{ id: 'team-1', name: 'Hawks' }],
        _count: { teams: 1 },
      };
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(summary);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      // Affiliated (#443): `canReadLeague` finds a team of theirs in the league.
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ personalOwnerId: null });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);

      const result = await SeasonService.getSeasonById(season.id, player.id);

      expect(result.id).toBe(season.id);
      expect(result.teams).toEqual([{ id: 'team-1', name: 'Hawks' }]);
      // Only the summary include was fetched — never the staff/member detail
      expect(mockPrisma.season.findUnique).toHaveBeenCalledTimes(1);
      const call = (mockPrisma.season.findUnique as jest.Mock).mock.calls[0][0];
      expect(call.include.teams).toEqual({ select: { id: true, name: true } });
    });

    // #443 deviation, same as LeagueService.getLeagueById: there was no access
    // check here at all. 404 not 403 so ids can't be probed.
    it('404s for a caller with no affiliation to the season\'s league', async () => {
      const player = createPlayer();
      const season = createSeason();
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league: { id: season.leagueId, name: 'L' },
        teams: [],
        _count: { teams: 0 },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ personalOwnerId: null });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);

      await expect(SeasonService.getSeasonById(season.id, player.id)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Season not found',
      });
    });

    it('returns full detail (staff + members) for a league admin', async () => {
      const coach = createCoach();
      const season = createSeason();
      const summary = {
        ...season,
        league: { id: season.leagueId, name: 'L' },
        teams: [],
        _count: { teams: 0 },
      };
      const detail = {
        ...summary,
        teams: [{ id: 'team-1', name: 'Hawks', staff: [], members: [], _count: { members: 0, games: 0 } }],
      };
      (mockPrisma.season.findUnique as jest.Mock)
        .mockResolvedValueOnce(summary)
        .mockResolvedValueOnce(detail);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({
        leagueId: season.leagueId,
        userId: coach.id,
      });

      const result = await SeasonService.getSeasonById(season.id, coach.id);

      expect(result.teams[0]).toHaveProperty('staff');
      expect(mockPrisma.leagueAdmin.findUnique).toHaveBeenCalledWith({
        where: { leagueId_userId: { leagueId: season.leagueId, userId: coach.id } },
      });
      const detailCall = (mockPrisma.season.findUnique as jest.Mock).mock.calls[1][0];
      expect(detailCall.include.teams.include.staff).toBeDefined();
      expect(detailCall.include.teams.include.members).toBeDefined();
    });

    it('returns full detail for a system admin', async () => {
      const admin = createAdmin();
      const season = createSeason();
      const base = { ...season, league: { id: season.leagueId, name: 'L' }, teams: [], _count: { teams: 0 } };
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(base);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);

      await SeasonService.getSeasonById(season.id, admin.id);

      expect(mockPrisma.season.findUnique).toHaveBeenCalledTimes(2);
      expect(mockPrisma.leagueAdmin.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when not found', async () => {
      const admin = createAdmin();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
      try {
        await SeasonService.getSeasonById('nope', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Season not found');
      }
    });

    it('throws NotFoundError when the detail row vanishes between lookups', async () => {
      const admin = createAdmin();
      const season = createSeason();
      const base = { ...season, league: { id: season.leagueId, name: 'L' }, teams: [], _count: { teams: 0 } };
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock)
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(null);

      await expect(SeasonService.getSeasonById(season.id, admin.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('listSeasons (#443 caller scoping)', () => {
    const ADMIN = { id: 'admin-1', role: 'ADMIN' };
    const COACH = { id: 'user-1', role: 'COACH' };

    /** Make `getReadableLeagueIds` resolve to the given league ids. */
    function readable(ids: string[]): void {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue(
        ids.map((leagueId) => ({ leagueId }))
      );
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);
    }

    it('ANDs every filter with the access clause and returns the envelope', async () => {
      const seasons = [createSeason(), createSeason()];
      readable(['league-1', 'league-2']);
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue(seasons);

      const result = await SeasonService.listSeasons(
        { leagueId: 'league-1', isActive: true, search: 'spring', limit: 10, offset: 5 },
        COACH
      );

      // A leagueId filter also answers whether the caller may create there (#461).
      expect(result).toEqual({ seasons, total: 2, limit: 10, offset: 5, canCreate: expect.any(Boolean) });

      const findArgs = (mockPrisma.season.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toEqual({
        AND: [
          { leagueId: 'league-1' },
          { isActive: true },
          { name: { contains: 'spring', mode: 'insensitive' } },
          { leagueId: { in: ['league-1', 'league-2'] } },
        ],
      });
      expect(findArgs.take).toBe(10);
      expect(findArgs.skip).toBe(5);
      // Same clause on both queries, or `total` leaks the global count.
      expect((mockPrisma.season.count as jest.Mock).mock.calls[0][0].where).toEqual(findArgs.where);
    });

    // A leagueId filter naming a league the caller cannot read must not widen
    // the result: the access clause still applies.
    it('does not let a leagueId filter bypass scoping', async () => {
      readable(['league-mine']);
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue([]);

      await SeasonService.listSeasons({ leagueId: 'league-theirs', limit: 20, offset: 0 }, COACH);

      expect((mockPrisma.season.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        AND: [{ leagueId: 'league-theirs' }, { leagueId: { in: ['league-mine'] } }],
      });
    });

    describe('canCreate (the rollover form\'s "new season" hint, #461)', () => {
      let isLeagueAdmin: jest.SpyInstance;
      beforeEach(() => {
        isLeagueAdmin = jest.spyOn(permissions, 'isLeagueAdmin');
        (mockPrisma.season.count as jest.Mock).mockResolvedValue(0);
        (mockPrisma.season.findMany as jest.Mock).mockResolvedValue([]);
      });
      afterEach(() => isLeagueAdmin.mockRestore());

      it('is the POST /seasons rule (isLeagueAdmin) on the filtered league', async () => {
        readable(['league-1']);
        isLeagueAdmin.mockResolvedValue(true);
        await expect(
          SeasonService.listSeasons({ leagueId: 'league-1', limit: 20, offset: 0 }, COACH)
        ).resolves.toMatchObject({ canCreate: true });
        expect(isLeagueAdmin).toHaveBeenCalledWith(COACH.id, 'league-1');

        isLeagueAdmin.mockResolvedValue(false);
        await expect(
          SeasonService.listSeasons({ leagueId: 'league-1', limit: 20, offset: 0 }, COACH)
        ).resolves.toMatchObject({ canCreate: false });
      });

      it('is absent without a leagueId filter', async () => {
        readable(['league-1']);
        const result = await SeasonService.listSeasons({ limit: 20, offset: 0 }, COACH);
        expect('canCreate' in result).toBe(false);
        expect(isLeagueAdmin).not.toHaveBeenCalled();
      });

      it('is false, without asking, for a caller who can read no league', async () => {
        readable([]);
        const result = await SeasonService.listSeasons({ leagueId: 'league-1', limit: 20, offset: 0 }, COACH);
        expect(result).toEqual({ seasons: [], total: 0, limit: 20, offset: 0, canCreate: false });
        expect(isLeagueAdmin).not.toHaveBeenCalled();
      });
    });

    it('short-circuits when the caller can read no leagues', async () => {
      readable([]);

      const result = await SeasonService.listSeasons({ limit: 20, offset: 0 }, COACH);

      expect(result).toEqual({ seasons: [], total: 0, limit: 20, offset: 0 });
      expect(mockPrisma.season.findMany).not.toHaveBeenCalled();
    });

    it('leaves a system ADMIN unscoped but hides personal-league seasons by default', async () => {
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue([]);

      await SeasonService.listSeasons({ limit: 20, offset: 0 }, ADMIN);

      expect((mockPrisma.season.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        AND: [{ league: { personalOwnerId: null } }],
      });
    });

    it('does not hide personal-league seasons from an ADMIN who names the league (#461)', async () => {
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue([]);

      await SeasonService.listSeasons({ leagueId: 'league-personal', limit: 20, offset: 0 }, ADMIN);

      expect((mockPrisma.season.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        AND: [{ leagueId: 'league-personal' }],
      });
    });

    it('lets an ADMIN opt into personal-league seasons', async () => {
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue([]);

      await SeasonService.listSeasons({ includePersonal: true, limit: 20, offset: 0 }, ADMIN);

      expect((mockPrisma.season.findMany as jest.Mock).mock.calls[0][0].where).toEqual({});
    });
  });

  describe('updateSeason', () => {
    it('throws NotFoundError when season missing', async () => {
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
      try {
        await SeasonService.updateSeason('missing', { name: 'x' }, 'user-1');
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Season not found');
      }
    });

    it('throws BadRequestError when caller is not league admin', async () => {
      const coach = createCoach();
      const season = createSeason();
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league: createLeague({ id: season.leagueId }),
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await SeasonService.updateSeason(season.id, { name: 'x' }, coach.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'You do not have permission to update this season');
      }
    });

    it('rejects duplicate name within same league', async () => {
      const admin = createAdmin();
      const season = createSeason();
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league: createLeague({ id: season.leagueId }),
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findFirst as jest.Mock).mockResolvedValue(
        createSeason({ leagueId: season.leagueId, name: 'Taken' })
      );

      try {
        await SeasonService.updateSeason(season.id, { name: 'Taken' }, admin.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(
          err,
          'A season with this name already exists in this league'
        );
      }
      expect(mockPrisma.season.update).not.toHaveBeenCalled();
    });

    it('rejects inverted dates using existing season data for missing fields', async () => {
      const admin = createAdmin();
      // Existing endDate sits before new startDate
      const season = createSeason({
        endDate: new Date('2026-01-01'),
        startDate: null,
      });
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league: createLeague({ id: season.leagueId }),
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);

      try {
        await SeasonService.updateSeason(
          season.id,
          { startDate: new Date('2026-06-01') },
          admin.id
        );
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(err, 'Start date must be before end date');
      }
    });

    it('clearing startDate to null does not fall back to the stored date for the range check', async () => {
      const admin = createAdmin();
      // Stored startDate (Sep) is after the new endDate (Jun). If the cleared
      // startDate leaked through `??` the range check would reject this update.
      const season = createSeason({
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-12-01'),
      });
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league: createLeague({ id: season.leagueId }),
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.update as jest.Mock).mockResolvedValue({
        ...season,
        startDate: null,
        endDate: new Date('2026-06-01'),
      });

      await SeasonService.updateSeason(
        season.id,
        { startDate: null, endDate: new Date('2026-06-01') },
        admin.id
      );

      const updateArgs = (mockPrisma.season.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.startDate).toBeNull();
      expect(updateArgs.data.endDate).toEqual(new Date('2026-06-01'));
    });

    it('applies updates and returns the updated season', async () => {
      const admin = createAdmin();
      const season = createSeason({ name: 'Old' });
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league: createLeague({ id: season.leagueId }),
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findFirst as jest.Mock).mockResolvedValue(null);
      const updated = { ...season, name: 'New', isActive: false };
      (mockPrisma.season.update as jest.Mock).mockResolvedValue(updated);

      const result = await SeasonService.updateSeason(
        season.id,
        { name: 'New', isActive: false },
        admin.id
      );

      expect(result.name).toBe('New');
      const updateArgs = (mockPrisma.season.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: season.id });
      expect(updateArgs.data).toEqual({ name: 'New', isActive: false });
    });
  });

  describe('deleteSeason', () => {
    it('rejects non-system-admin callers', async () => {
      const coach = createCoach();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await SeasonService.deleteSeason('season-1', coach.id);
        fail('expected to throw');
      } catch (err) {
        expectForbiddenError(err, 'Only system administrators can delete seasons');
      }
      expect(mockPrisma.season.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when season missing', async () => {
      const admin = createAdmin();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await SeasonService.deleteSeason('missing', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectNotFoundError(err, 'Season not found');
      }
    });

    it('refuses to delete when teams still exist', async () => {
      const admin = createAdmin();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...createSeason(),
        teams: [{ id: 't1' }],
      });

      try {
        await SeasonService.deleteSeason('s1', admin.id);
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(
          err,
          'Cannot delete season with existing teams. Remove teams first.'
        );
      }
      expect(mockPrisma.season.delete).not.toHaveBeenCalled();
    });

    it('deletes when admin and no teams', async () => {
      const admin = createAdmin();
      const season = createSeason();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        teams: [],
      });
      (mockPrisma.season.delete as jest.Mock).mockResolvedValue(season);

      const result = await SeasonService.deleteSeason(season.id, admin.id);
      expect(result).toEqual({ success: true });
      expect(mockPrisma.season.delete).toHaveBeenCalledWith({
        where: { id: season.id },
      });
    });

    it('logs one `Season deleted` domain event with ids only (#686)', async () => {
      const admin = createAdmin();
      const season = createSeason({ name: 'Secret Season Name' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ ...season, teams: [] });
      (mockPrisma.season.delete as jest.Mock).mockResolvedValue(season);
      const infoSpy = spyOnInfo();

      await SeasonService.deleteSeason(season.id, admin.id);

      expect(domainEvent(infoSpy, 'Season deleted')).toEqual({
        seasonId: season.id,
        leagueId: season.leagueId,
        userId: admin.id,
      });
    });
  });
});
