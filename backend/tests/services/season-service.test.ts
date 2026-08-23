/**
 * Unit tests for SeasonService
 *
 * Covers permission gating (league admin / system admin), uniqueness,
 * date-range validation, and delete guards.
 */

import { SeasonService } from '../../src/services/season-service';
import { mockPrisma } from '../setup';
import {
  createAdmin,
  createCoach,
  createLeague,
  createPlayer,
  createSeason,
} from '../factories';
import { expectBadRequestError, expectForbiddenError, expectNotFoundError } from '../helpers';

describe('SeasonService', () => {
  describe('createSeason', () => {
    it('creates a season when caller is a league admin', async () => {
      const admin = createAdmin();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id, name: 'Fall 2026' });

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      // isLeagueAdmin: first looks up user (admin role), short-circuits true
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.season.create as jest.Mock).mockResolvedValue(season);

      const result = await SeasonService.createSeason(
        { leagueId: league.id, name: 'Fall 2026' },
        admin.id
      );

      expect(result.id).toBe(season.id);
      expect(mockPrisma.season.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            leagueId: league.id,
            name: 'Fall 2026',
            isActive: true,
          }),
        })
      );
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

    it('rejects duplicate season name within the same league', async () => {
      const admin = createAdmin();
      const league = createLeague();
      const existing = createSeason({ leagueId: league.id, name: 'Fall' });

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(existing);

      try {
        await SeasonService.createSeason(
          { leagueId: league.id, name: 'Fall' },
          admin.id
        );
        fail('expected to throw');
      } catch (err) {
        expectBadRequestError(
          err,
          'A season with this name already exists in this league'
        );
      }
      expect(mockPrisma.season.create).not.toHaveBeenCalled();
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
    it('returns metadata + team names only for a user who is not a league admin', async () => {
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

      const result = await SeasonService.getSeasonById(season.id, player.id);

      expect(result.id).toBe(season.id);
      expect(result.teams).toEqual([{ id: 'team-1', name: 'Hawks' }]);
      // Only the summary include was fetched — never the staff/member detail
      expect(mockPrisma.season.findUnique).toHaveBeenCalledTimes(1);
      const call = (mockPrisma.season.findUnique as jest.Mock).mock.calls[0][0];
      expect(call.include.teams).toEqual({ select: { id: true, name: true } });
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

  describe('listSeasons', () => {
    it('applies leagueId, isActive, and search filters; returns pagination envelope', async () => {
      const seasons = [createSeason(), createSeason()];
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue(seasons);

      const result = await SeasonService.listSeasons({
        leagueId: 'league-1',
        isActive: true,
        search: 'spring',
        limit: 10,
        offset: 5,
      });

      expect(result).toEqual({
        seasons,
        total: 2,
        limit: 10,
        offset: 5,
      });

      const findArgs = (mockPrisma.season.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toEqual({
        leagueId: 'league-1',
        isActive: true,
        name: { contains: 'spring', mode: 'insensitive' },
      });
      expect(findArgs.take).toBe(10);
      expect(findArgs.skip).toBe(5);
    });

    it('omits filters when not provided', async () => {
      (mockPrisma.season.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.season.findMany as jest.Mock).mockResolvedValue([]);

      await SeasonService.listSeasons({ limit: 20, offset: 0 });

      const findArgs = (mockPrisma.season.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toEqual({});
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
  });
});
