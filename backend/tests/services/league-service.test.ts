/**
 * Unit tests for LeagueService
 */

import { LeagueService } from '../../src/services/league-service';
import { mockPrisma } from '../setup';
import { createLeague, createSeason, createTeam, createCoach, createAdmin } from '../factories';
import { expectNotFoundError, expectBadRequestError } from '../helpers';

describe('LeagueService', () => {
  describe('createLeague', () => {
    it('should create a league successfully when user is system admin', async () => {
      const admin = createAdmin();
      const league = createLeague({ name: 'Spring League' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.league.create as jest.Mock).mockResolvedValue({
        ...league,
        seasons: [],
        admins: [],
      });

      const result = await LeagueService.createLeague(
        { name: 'Spring League' },
        admin.id
      );

      expect(result).toHaveProperty('id', league.id);
      expect(result).toHaveProperty('name', 'Spring League');
      expect(mockPrisma.league.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Spring League',
          }),
        })
      );
    });

    it('should throw BadRequestError if user is not system admin', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await LeagueService.createLeague({ name: 'Spring League' }, coach.id);
      } catch (error) {
        expectBadRequestError(error, 'Only system administrators can create leagues');
      }
    });

    it('should throw BadRequestError if league with same name exists', async () => {
      const admin = createAdmin();
      const existingLeague = createLeague({ name: 'Spring League' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findFirst as jest.Mock).mockResolvedValue(existingLeague);

      try {
        await LeagueService.createLeague({ name: 'Spring League' }, admin.id);
      } catch (error) {
        expectBadRequestError(error, 'League with this name already exists');
      }
    });
  });

  describe('getLeagueById', () => {
    it('should return league with seasons and teams', async () => {
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });

      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({
        ...league,
        seasons: [{
          ...season,
          teams: [{
            ...team,
            staff: [],
            members: [],
          }],
        }],
        admins: [],
      });

      const result = await LeagueService.getLeagueById(league.id);

      expect(result).toHaveProperty('id', league.id);
      expect(result.seasons).toHaveLength(1);
      expect(result.seasons[0].teams).toHaveLength(1);
    });

    it('should throw NotFoundError if league does not exist', async () => {
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.getLeagueById('non-existent');
      } catch (error) {
        expectNotFoundError(error, 'League not found');
      }
    });
  });

  describe('listLeagues', () => {
    it('should return all leagues with pagination', async () => {
      const league1 = createLeague({ name: 'League 1' });
      const league2 = createLeague({ name: 'League 2' });

      (mockPrisma.league.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue([
        { ...league1, seasons: [], admins: [], _count: { seasons: 0 } },
        { ...league2, seasons: [], admins: [], _count: { seasons: 0 } },
      ]);

      const result = await LeagueService.listLeagues({ limit: 10, offset: 0 });

      expect(result.leagues).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    it('should filter by search term', async () => {
      const league = createLeague({ name: 'Spring League' });

      (mockPrisma.league.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue([
        { ...league, seasons: [], admins: [], _count: { seasons: 0 } },
      ]);

      const result = await LeagueService.listLeagues({ search: 'Spring', limit: 10, offset: 0 });

      expect(result.leagues).toHaveLength(1);
      expect(mockPrisma.league.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            name: expect.objectContaining({
              contains: 'Spring',
              mode: 'insensitive',
            }),
          }),
        })
      );
    });

    it('should handle empty results', async () => {
      (mockPrisma.league.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue([]);

      const result = await LeagueService.listLeagues({ limit: 10, offset: 0 });

      expect(result.leagues).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('updateLeague', () => {
    it('should update league name when user is league admin', async () => {
      const admin = createAdmin();
      const league = createLeague({ name: 'Old Name' });
      const updatedLeague = { ...league, name: 'New Name' };

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.league.update as jest.Mock).mockResolvedValue({
        ...updatedLeague,
        seasons: [],
        admins: [],
      });

      const result = await LeagueService.updateLeague(league.id, { name: 'New Name' }, admin.id);

      expect(result).toHaveProperty('name', 'New Name');
      expect(mockPrisma.league.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: league.id },
          data: expect.objectContaining({ name: 'New Name' }),
        })
      );
    });

    it('should throw NotFoundError if league does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.updateLeague('non-existent', { name: 'New Name' }, admin.id);
      } catch (error) {
        expectNotFoundError(error, 'League not found');
      }
    });

    it('should throw BadRequestError if user is not league admin', async () => {
      const coach = createCoach();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.updateLeague(league.id, { name: 'New Name' }, coach.id);
      } catch (error) {
        expectBadRequestError(error, 'You do not have permission to update this league');
      }
    });
  });

  describe('deleteLeague', () => {
    it('should delete league successfully when user is system admin', async () => {
      const admin = createAdmin();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({
        ...league,
        seasons: [],
      });
      (mockPrisma.league.delete as jest.Mock).mockResolvedValue(league);

      const result = await LeagueService.deleteLeague(league.id, admin.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.league.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: league.id },
        })
      );
    });

    it('should throw BadRequestError if user is not system admin', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await LeagueService.deleteLeague('league-id', coach.id);
      } catch (error) {
        expectBadRequestError(error, 'Only system administrators can delete leagues');
      }
    });

    it('should throw NotFoundError if league does not exist', async () => {
      const admin = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.deleteLeague('non-existent', admin.id);
      } catch (error) {
        expectNotFoundError(error, 'League not found');
      }
    });

    it('should throw BadRequestError if league has seasons with teams', async () => {
      const admin = createAdmin();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({
        ...league,
        seasons: [{
          ...season,
          teams: [team],
        }],
      });

      try {
        await LeagueService.deleteLeague(league.id, admin.id);
      } catch (error) {
        expectBadRequestError(error, 'Cannot delete league with existing teams. Remove teams first.');
      }
    });
  });
});
