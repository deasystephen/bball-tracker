/**
 * Unit tests for LeagueService
 */

import { LeagueService } from '../../src/services/league-service';
import { mockPrisma } from '../setup';
import { createLeague, createSeason, createTeam, createCoach, createAdmin, createPlayer } from '../factories';
import { expectNotFoundError, expectBadRequestError, expectForbiddenError } from '../helpers';

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

    it('should throw ForbiddenError if user is not system admin', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await LeagueService.createLeague({ name: 'Spring League' }, coach.id);
      } catch (error) {
        expectForbiddenError(error, 'Only system administrators can create leagues');
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
    it('should return full detail (admins, staff, members) for a system admin', async () => {
      const admin = createAdmin();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
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

      const result = await LeagueService.getLeagueById(league.id, admin.id);

      expect(result).toHaveProperty('id', league.id);
      expect(result.seasons).toHaveLength(1);
      expect(result.seasons[0].teams).toHaveLength(1);
      expect(result).toHaveProperty('admins');
      // Full detail include was used (staff + members nested under teams)
      const call = (mockPrisma.league.findUnique as jest.Mock).mock.calls[0][0];
      expect(call.include.admins).toBeDefined();
      expect(call.include.seasons.include.teams.include.staff).toBeDefined();
      expect(call.include.seasons.include.teams.include.members).toBeDefined();
    });

    it('should return full detail for a league admin', async () => {
      const coach = createCoach();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({
        leagueId: league.id,
        userId: coach.id,
      });
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({
        ...league,
        seasons: [],
        admins: [],
      });

      await LeagueService.getLeagueById(league.id, coach.id);

      const call = (mockPrisma.league.findUnique as jest.Mock).mock.calls[0][0];
      expect(call.include.admins).toBeDefined();
    });

    it('should return metadata + team names only (no staff, members, admins) for an AFFILIATED non-admin', async () => {
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      // Affiliated: `canReadLeague` finds a team in this league they belong to.
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({
        ...league,
        personalOwnerId: null,
        seasons: [{ ...season, teams: [{ id: team.id, name: team.name }] }],
      });

      const result = await LeagueService.getLeagueById(league.id, player.id);

      expect(result).toHaveProperty('id', league.id);
      expect(result.seasons[0].teams[0]).toEqual({ id: team.id, name: team.name });
      expect(result).not.toHaveProperty('admins');
      const call = (mockPrisma.league.findUnique as jest.Mock).mock.calls.at(-1)![0];
      expect(call.include.admins).toBeUndefined();
      expect(call.include.seasons.include.teams).toEqual({
        select: { id: true, name: true },
      });
    });

    // #443 deviation: this endpoint previously had NO access check at all —
    // `isLeagueAdmin` only chose the `include`. 404 not 403 so ids can't be
    // probed, matching PlayerService.getPlayerById.
    it('should 404 for a caller with no affiliation to the league', async () => {
      const player = createPlayer();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ personalOwnerId: null });
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(0);

      await expect(LeagueService.getLeagueById(league.id, player.id)).rejects.toMatchObject({
        statusCode: 404,
        message: 'League not found',
      });
    });

    it('should throw NotFoundError if league does not exist', async () => {
      const admin = createAdmin();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(LeagueService.getLeagueById('non-existent', admin.id)).rejects.toMatchObject({
        statusCode: 404,
        message: 'League not found',
      });
    });
  });

  describe('listLeagues (#443 caller scoping)', () => {
    const ADMIN = { id: 'admin-1', role: 'ADMIN' };
    const COACH = { id: 'user-1', role: 'COACH' };

    function rows(...names: string[]): unknown[] {
      return names.map((name) => ({
        ...createLeague({ name }),
        personalOwnerId: null,
        seasons: [],
        admins: [],
        _count: { seasons: 0 },
      }));
    }

    /** Make `getReadableLeagueIds` resolve to the given league ids. */
    function readable(ids: string[]): void {
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue(
        ids.map((leagueId) => ({ leagueId }))
      );
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);
    }

    it('scopes a non-admin to the leagues they can read', async () => {
      readable(['league-a', 'league-b']);
      (mockPrisma.league.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue(rows('League 1', 'League 2'));

      const result = await LeagueService.listLeagues({ limit: 10, offset: 0 }, COACH);

      expect(result.leagues).toHaveLength(2);
      const where = (mockPrisma.league.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toEqual({ AND: [{ id: { in: ['league-a', 'league-b'] } }] });
      // The scoped clause must reach BOTH queries, or `total` leaks the global
      // count while the rows are scoped.
      expect((mockPrisma.league.count as jest.Mock).mock.calls[0][0].where).toEqual(where);
    });

    it('short-circuits to an empty page when the caller can read nothing', async () => {
      readable([]);

      const result = await LeagueService.listLeagues({ limit: 10, offset: 0 }, COACH);

      expect(result).toEqual({ leagues: [], total: 0, limit: 10, offset: 0 });
      expect(mockPrisma.league.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.league.count).not.toHaveBeenCalled();
    });

    // search must not be a scoping bypass: it is ANDed alongside the access
    // clause, never substituted for it.
    it('ANDs the search filter with the access clause', async () => {
      readable(['league-a']);
      (mockPrisma.league.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue(rows('Spring League'));

      await LeagueService.listLeagues({ search: 'Spring', limit: 10, offset: 0 }, COACH);

      expect((mockPrisma.league.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        AND: [
          { name: { contains: 'Spring', mode: 'insensitive' } },
          { id: { in: ['league-a'] } },
        ],
      });
    });

    it('leaves a system ADMIN unscoped, but hides personal leagues by default', async () => {
      (mockPrisma.league.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue(rows('League 1'));

      await LeagueService.listLeagues({ limit: 10, offset: 0 }, ADMIN);

      expect((mockPrisma.league.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        AND: [{ personalOwnerId: null }],
      });
      // No access resolution for an admin.
      expect(mockPrisma.leagueAdmin.findMany).not.toHaveBeenCalled();
    });

    it('lets an ADMIN opt into personal leagues', async () => {
      (mockPrisma.league.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue(rows('League 1'));

      await LeagueService.listLeagues({ includePersonal: true, limit: 10, offset: 0 }, ADMIN);

      expect((mockPrisma.league.findMany as jest.Mock).mock.calls[0][0].where).toEqual({});
    });

    it('derives isPersonal without leaking personalOwnerId', async () => {
      readable(['league-a']);
      (mockPrisma.league.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.league.findMany as jest.Mock).mockResolvedValue([
        {
          ...createLeague({ name: "Dana's Teams" }),
          personalOwnerId: 'someone-else',
          seasons: [],
          admins: [],
          _count: { seasons: 0 },
        },
      ]);

      const result = await LeagueService.listLeagues({ limit: 10, offset: 0 }, COACH);

      expect(result.leagues[0].isPersonal).toBe(true);
      expect(result.leagues[0]).not.toHaveProperty('personalOwnerId');
    });
  });

  describe('updateLeague', () => {
    it('should update league name when user is league admin', async () => {
      const admin = createAdmin();
      const league = createLeague({ name: 'Old Name' });
      const updatedLeague = { ...league, name: 'New Name' };

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.league.findFirst as jest.Mock).mockResolvedValue(null);
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

    it('should throw ForbiddenError if user is not league admin', async () => {
      const coach = createCoach();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      const error = await LeagueService.updateLeague(league.id, { name: 'New Name' }, coach.id).catch(
        (e) => e
      );
      expectForbiddenError(error, 'You do not have permission to update this league');
    });

    it('should throw BadRequestError if another league already has the new name', async () => {
      const admin = createAdmin();
      const league = createLeague({ name: 'Old Name' });
      const other = createLeague({ name: 'Taken' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.league.findFirst as jest.Mock).mockResolvedValue(other);

      const error = await LeagueService.updateLeague(league.id, { name: 'Taken' }, admin.id).catch(
        (e) => e
      );
      expectBadRequestError(error, 'League with this name already exists');
      expect(mockPrisma.league.findFirst).toHaveBeenCalledWith({
        where: { name: 'Taken', id: { not: league.id } },
      });
      expect(mockPrisma.league.update).not.toHaveBeenCalled();
    });

    it('should allow renaming a league to a name only it holds', async () => {
      const admin = createAdmin();
      const league = createLeague({ name: 'Old Name' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(league);
      (mockPrisma.league.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.league.update as jest.Mock).mockResolvedValue({ ...league, seasons: [], admins: [] });

      await LeagueService.updateLeague(league.id, { name: 'Old Name' }, admin.id);
      expect(mockPrisma.league.update).toHaveBeenCalled();
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

    it('should throw ForbiddenError if user is not system admin', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await LeagueService.deleteLeague('league-id', coach.id);
      } catch (error) {
        expectForbiddenError(error, 'Only system administrators can delete leagues');
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
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ id: league.id });
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

    // Decision 3: league admins can no longer grant the role to others — the
    // previous behaviour let any league admin silently extend the admin set.
    it('should reject an existing league admin who is not a system admin (403)', async () => {
      const callerCoach = createCoach({ id: 'existing-league-admin' });
      const league = createLeague();
      const newAdmin = createCoach({ id: 'new-admin' });

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === callerCoach.id) return Promise.resolve(callerCoach); // role COACH
        if (args.where.id === newAdmin.id) return Promise.resolve(newAdmin);
        return Promise.resolve(null);
      });
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue({ leagueId: league.id, userId: callerCoach.id });

      await expect(
        LeagueService.addLeagueAdmin(league.id, newAdmin.id, callerCoach.id)
      ).rejects.toMatchObject({ statusCode: 403, message: 'Only system administrators can manage league admins' });
      expect(mockPrisma.leagueAdmin.create).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenError if caller is neither system admin nor league admin', async () => {
      const randomUser = createPlayer();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(randomUser);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await LeagueService.addLeagueAdmin(league.id, 'some-user', randomUser.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'Only system administrators can manage league admins');
      }
      expect(mockPrisma.leagueAdmin.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if the league does not exist', async () => {
      const sysAdmin = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(sysAdmin);
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        LeagueService.addLeagueAdmin('missing-league', 'some-user', sysAdmin.id)
      ).rejects.toMatchObject({ statusCode: 404, message: 'League not found' });
      expect(mockPrisma.leagueAdmin.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if target user does not exist', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
        if (args.where.id === sysAdmin.id) return Promise.resolve(sysAdmin);
        return Promise.resolve(null);
      });
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ id: league.id });

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
      (mockPrisma.league.findUnique as jest.Mock).mockResolvedValue({ id: league.id });
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
      (mockPrisma.leagueAdmin.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await LeagueService.removeLeagueAdmin(league.id, target.id, sysAdmin.id);
      expect(result).toEqual({ success: true });
      expect(mockPrisma.leagueAdmin.deleteMany).toHaveBeenCalledWith({
        where: { leagueId: league.id, userId: target.id },
      });
    });

    it('should throw NotFoundError when the user is not an admin of the league', async () => {
      const sysAdmin = createAdmin();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(sysAdmin);
      (mockPrisma.leagueAdmin.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(
        LeagueService.removeLeagueAdmin(league.id, 'not-an-admin', sysAdmin.id)
      ).rejects.toMatchObject({ statusCode: 404, message: 'League admin not found' });
    });

    it('should throw ForbiddenError when caller is not a system admin', async () => {
      const coach = createCoach();
      const league = createLeague();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await LeagueService.removeLeagueAdmin(league.id, 'target', coach.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'Only system administrators can remove league admins');
      }
      expect(mockPrisma.leagueAdmin.deleteMany).not.toHaveBeenCalled();
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
        expectForbiddenError(error, 'You do not have permission to create seasons for this league');
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
