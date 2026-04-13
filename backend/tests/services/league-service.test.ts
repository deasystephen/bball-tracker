/**
 * Unit tests for LeagueService
 */

import { LeagueService } from '../../src/services/league-service';
import { mockPrisma } from '../setup';
import { createLeague, createSeason, createTeam, createCoach, createAdmin, createPlayer } from '../factories';
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

  describe('addLeagueAdmin', () => {
    it('should add a new league admin when caller is a system admin', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();
      const newAdmin = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === sysAdmin.id) return Promise.resolve(sysAdmin);
        if (args.where.id === newAdmin.id) return Promise.resolve(newAdmin);
        return Promise.resolve(null);
      });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.leagueAdmin.create as jest.Mock).mockResolvedValue({
        leagueId: league.id,
        userId: newAdmin.id,
        user: { id: newAdmin.id, name: newAdmin.name, email: newAdmin.email },
      });

      const result = await LeagueService.addLeagueAdmin(league.id, newAdmin.id, sysAdmin.id);

      expect(result.user.id).toBe(newAdmin.id);
      expect(mockPrisma.leagueAdmin.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { leagueId: league.id, userId: newAdmin.id },
        })
      );
    });

    it('should add a new league admin when caller is an existing league admin', async () => {
      const callerCoach = createCoach({ id: 'existing-league-admin' });
      const league = createLeague();
      const newAdmin = createCoach({ id: 'new-admin' });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === callerCoach.id) return Promise.resolve(callerCoach); // role COACH
        if (args.where.id === newAdmin.id) return Promise.resolve(newAdmin);
        return Promise.resolve(null);
      });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockImplementation((args: { where: { leagueId_userId: { userId: string } } }) => {
        if (args.where.leagueId_userId.userId === callerCoach.id) {
          return Promise.resolve({ leagueId: league.id, userId: callerCoach.id });
        }
        return Promise.resolve(null);
      });
      (mockPrisma.leagueAdmin.create as jest.Mock).mockResolvedValue({
        leagueId: league.id,
        userId: newAdmin.id,
        user: { id: newAdmin.id, name: newAdmin.name, email: newAdmin.email },
      });

      const result = await LeagueService.addLeagueAdmin(league.id, newAdmin.id, callerCoach.id);
      expect(result.user.id).toBe(newAdmin.id);
    });

    it('should throw BadRequestError if caller is neither system admin nor league admin', async () => {
      const randomUser = createPlayer();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(randomUser);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.addLeagueAdmin(league.id, 'some-user', randomUser.id);
        fail('Expected BadRequestError');
      } catch (error) {
        expectBadRequestError(error, 'You do not have permission to manage league admins');
      }
      expect(mockPrisma.leagueAdmin.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if target user does not exist', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === sysAdmin.id) return Promise.resolve(sysAdmin);
        return Promise.resolve(null);
      });

      try {
        await LeagueService.addLeagueAdmin(league.id, 'missing-user', sysAdmin.id);
        fail('Expected NotFoundError');
      } catch (error) {
        expectNotFoundError(error, 'User not found');
      }
      expect(mockPrisma.leagueAdmin.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestError if user is already a league admin', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();
      const existingAdmin = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === sysAdmin.id) return Promise.resolve(sysAdmin);
        if (args.where.id === existingAdmin.id) return Promise.resolve(existingAdmin);
        return Promise.resolve(null);
      });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({
        leagueId: league.id,
        userId: existingAdmin.id,
      });

      try {
        await LeagueService.addLeagueAdmin(league.id, existingAdmin.id, sysAdmin.id);
        fail('Expected BadRequestError');
      } catch (error) {
        expectBadRequestError(error, 'User is already an admin of this league');
      }
      expect(mockPrisma.leagueAdmin.create).not.toHaveBeenCalled();
    });
  });

  describe('removeLeagueAdmin', () => {
    it('should remove a league admin when caller is a system admin', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();
      const target = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(sysAdmin);
      (mockPrisma.leagueAdmin.delete as jest.Mock).mockResolvedValue({});

      const result = await LeagueService.removeLeagueAdmin(league.id, target.id, sysAdmin.id);
      expect(result).toEqual({ success: true });
      expect(mockPrisma.leagueAdmin.delete).toHaveBeenCalledWith({
        where: { leagueId_userId: { leagueId: league.id, userId: target.id } },
      });
    });

    it('should throw BadRequestError when caller is not a system admin', async () => {
      const coach = createCoach();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await LeagueService.removeLeagueAdmin(league.id, 'target', coach.id);
        fail('Expected BadRequestError');
      } catch (error) {
        expectBadRequestError(error, 'Only system administrators can remove league admins');
      }
      expect(mockPrisma.leagueAdmin.delete).not.toHaveBeenCalled();
    });
  });

  describe('createSeason', () => {
    it('should create a season when caller is a system admin', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();
      const startDate = new Date('2026-03-01');
      const endDate = new Date('2026-06-30');

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(sysAdmin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
      const createdSeason = createSeason({ leagueId: league.id, name: 'Summer', startDate, endDate });
      (mockPrisma.season.create as jest.Mock).mockResolvedValue({
        ...createdSeason,
        league,
        teams: [],
      });

      const result = await LeagueService.createSeason(
        league.id,
        { name: 'Summer', startDate, endDate },
        sysAdmin.id
      );

      expect(result.name).toBe('Summer');
      expect(mockPrisma.season.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            leagueId: league.id,
            name: 'Summer',
            startDate,
            endDate,
            isActive: true,
          },
        })
      );
    });

    it('should throw BadRequestError when caller is not a league admin', async () => {
      const random = createPlayer();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(random);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.createSeason(league.id, { name: 'Summer' }, random.id);
        fail('Expected BadRequestError');
      } catch (error) {
        expectBadRequestError(error, 'You do not have permission to create seasons for this league');
      }
      expect(mockPrisma.season.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestError if a season with the same name already exists', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(sysAdmin);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(
        createSeason({ leagueId: league.id, name: 'Duplicate' })
      );

      try {
        await LeagueService.createSeason(league.id, { name: 'Duplicate' }, sysAdmin.id);
        fail('Expected BadRequestError');
      } catch (error) {
        expectBadRequestError(error, 'A season with this name already exists in this league');
      }
      expect(mockPrisma.season.create).not.toHaveBeenCalled();
    });
  });
});
