/**
 * Unit tests for GameService
 */

import { GameService } from '../../src/services/game-service';
import { emitGameScoreChange, emitGameStatusChange } from '../../src/websocket/emit';
import { mockPrisma } from '../setup';
import {
  createAdmin,
  createUser,
  createGame,
  createTeam,
  createCoach,
  createSeason,
  createLeague,
  createPlayer,
  createTeamMember,
  createTeamRole,
  createTeamStaff,
} from '../factories';
import { expectNotFoundError, expectForbiddenError, expectBadRequestError } from '../helpers';
import type { CreateGameInput } from '../../src/api/games/schemas';

jest.mock('../../src/websocket/emit', () => ({
  emitGameStatusChange: jest.fn(),
  emitGameScoreChange: jest.fn(),
}));

const mockEmitGameScoreChange = emitGameScoreChange as jest.Mock;
const mockEmitGameStatusChange = emitGameStatusChange as jest.Mock;

// Helper to create valid game input
const createGameInput = (overrides: {
  teamId: string;
  opponent: string;
  date: Date | string;
  status?: 'SCHEDULED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';
  homeScore?: number;
  awayScore?: number;
}): CreateGameInput => ({
  teamId: overrides.teamId,
  opponent: overrides.opponent,
  date: overrides.date,
  status: overrides.status || 'SCHEDULED',
  homeScore: overrides.homeScore ?? 0,
  awayScore: overrides.awayScore ?? 0,
});

describe('GameService', () => {
  describe('createGame', () => {
    it('should create a game successfully', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, opponent: 'Lakers' });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.game.create as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          season: { ...season, league },
          staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        },
      });

      const result = await GameService.createGame(
        createGameInput({
          teamId: team.id,
          opponent: 'Lakers',
          date: game.date,
        }),
        coach.id
      );

      expect(result).toHaveProperty('id', game.id);
      expect(result).toHaveProperty('opponent', 'Lakers');
      expect(mockPrisma.game.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teamId: team.id,
            opponent: 'Lakers',
          }),
        })
      );
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameService.createGame(
          createGameInput({
            teamId: 'non-existent',
            opponent: 'Lakers',
            date: new Date(),
          }),
          'coach-id'
        );
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageTeam permission', async () => {
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await GameService.createGame(
          createGameInput({
            teamId: team.id,
            opponent: 'Lakers',
            date: new Date(),
          }),
          otherUser.id
        );
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to create games for this team');
      }
    });
  });

  describe('getGameById', () => {
    it('should return game for staff member, including member emails (canManageRoster)', async () => {
      const coach = createCoach();
      const player = createPlayer({ email: 'kid@test.com' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          season: { ...season, league },
          staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
          members: [{ ...member, player: { id: player.id, name: player.name, email: player.email } }],
        },
        events: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      // getTeamPermissions → head coach role has canManageRoster
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);

      const result = await GameService.getGameById(game.id, coach.id);

      expect(result).toHaveProperty('id', game.id);
      expect(result.team.members[0].player).toEqual({ id: player.id, name: player.name, email: 'kid@test.com' });
      expect(result.team.staff[0].user.email).toBe(coach.email);
    });

    it('should return game for team member without other members\' emails (role matrix B2.5)', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const teammate = createPlayer({ email: 'teammate@test.com' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });
      const teammateMember = createTeamMember({ teamId: team.id, playerId: teammate.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          season: { ...season, league },
          staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
          members: [
            { ...member, player: { id: player.id, name: player.name, email: player.email } },
            { ...teammateMember, player: { id: teammate.id, name: teammate.name, email: teammate.email } },
          ],
        },
        events: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);

      const result = await GameService.getGameById(game.id, player.id);

      expect(result).toHaveProperty('id', game.id);
      expect(result.team.members).toHaveLength(2);
      for (const m of result.team.members) {
        expect(m.player).not.toHaveProperty('email');
      }
      expect(JSON.stringify(result.team.members)).not.toContain('teammate@test.com');
      // Staff (coach) contact info stays visible, as on the team detail
      expect(result.team.staff[0].user.email).toBe(coach.email);
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameService.getGameById('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const coach = createCoach();
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          season: { ...season, league },
          staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
          members: [],
        },
        events: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await GameService.getGameById(game.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this game');
      }
    });
  });

  describe('updateGame', () => {
    it('should update game when user has canManageTeam permission', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        opponent: 'New Opponent',
        team: {
          ...team,
          season: { ...season, league },
          staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        },
      });

      const result = await GameService.updateGame(game.id, { opponent: 'New Opponent' }, coach.id);

      expect(result).toHaveProperty('opponent', 'New Opponent');
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameService.updateGame('non-existent', { opponent: 'New Opponent' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user cannot update game', async () => {
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      const error = await GameService.updateGame(
        game.id,
        { opponent: 'New Opponent' },
        otherUser.id
      ).catch((e) => e);
      expectForbiddenError(error, 'You do not have access to this game');
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
    });

    it('should reject an empty body from an unaffiliated user with 403 before touching permissions (audit #12)', async () => {
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      const error = await GameService.updateGame(game.id, {}, otherUser.id).catch((e) => e);

      expectForbiddenError(error, 'You do not have access to this game');
      expect(mockPrisma.teamStaff.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
    });

    it('should reject an empty body from an authorized coach with 400', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);

      const error = await GameService.updateGame(game.id, {}, coach.id).catch((e) => e);

      expectBadRequestError(error, 'No fields to update');
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteGame', () => {
    it('should delete game when user has canManageTeam permission', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.game.delete as jest.Mock).mockResolvedValue(game);

      const result = await GameService.deleteGame(game.id, coach.id);

      expect(result).toEqual({ success: true });
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameService.deleteGame('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user cannot delete game', async () => {
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await GameService.deleteGame(game.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to delete this game');
      }
    });
  });

  describe('listGames', () => {
    const baseQuery = { limit: 20, offset: 0 };

    it('should return all matching games for a system admin without access filtering', async () => {
      const admin = createAdmin();
      const game1 = createGame({ opponent: 'Celtics' });
      const game2 = createGame({ opponent: 'Nets' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game1, game2]);

      const result = await GameService.listGames(baseQuery, admin.id);

      expect(result.total).toBe(2);
      expect(result.games).toHaveLength(2);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);

      // Admin path must NOT call team.findMany for access filtering
      expect(mockPrisma.team.findMany).not.toHaveBeenCalled();

      // where should NOT include teamId filter or { in: ... }
      const findManyCall = (mockPrisma.game.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.teamId).toBeUndefined();
    });

    it('should filter by teamId, status, and date range', async () => {
      const admin = createAdmin();
      const teamId = 'team-filter';
      const game = createGame({ teamId, opponent: 'Suns' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game]);

      const result = await GameService.listGames(
        {
          ...baseQuery,
          teamId,
          status: 'SCHEDULED',
          startDate: '2026-01-01T00:00:00Z',
          endDate: '2026-12-31T00:00:00Z',
        },
        admin.id
      );

      expect(result.total).toBe(1);

      const findManyArgs = (mockPrisma.game.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.where.teamId).toBe(teamId);
      expect(findManyArgs.where.status).toBe('SCHEDULED');
      expect(findManyArgs.where.date.gte).toBeInstanceOf(Date);
      expect(findManyArgs.where.date.lte).toBeInstanceOf(Date);
      expect(findManyArgs.take).toBe(20);
      expect(findManyArgs.skip).toBe(0);
      expect(findManyArgs.orderBy).toEqual({ date: 'desc' });
    });

    it('should restrict non-admin users to their accessible teams', async () => {
      const coach = createCoach();
      const team1Id = 'team-1';
      const team2Id = 'team-2';
      const game = createGame({ teamId: team1Id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([
        { id: team1Id },
        { id: team2Id },
      ]);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game]);

      const result = await GameService.listGames(baseQuery, coach.id);

      expect(result.games).toHaveLength(1);

      const findManyArgs = (mockPrisma.game.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyArgs.where.teamId).toEqual({ in: [team1Id, team2Id] });
    });

    it('should include teams the user administers via the league in the access set (audit #29)', async () => {
      const leagueAdmin = createCoach();
      const game = createGame({ teamId: 'team-1' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(leagueAdmin);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{ id: 'team-1' }]);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game]);

      await GameService.listGames(baseQuery, leagueAdmin.id);

      expect(mockPrisma.team.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { staff: { some: { userId: leagueAdmin.id } } },
            { members: { some: { playerId: leagueAdmin.id } } },
            { season: { league: { admins: { some: { userId: leagueAdmin.id } } } } },
          ],
        },
        select: { id: true },
      });
    });

    it('includes teams the user\'s children play on for guardians (PARENT role)', async () => {
      const parent = createUser({ role: 'PARENT' });
      const game = createGame({ teamId: 'team-1' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(parent);
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValueOnce([{ childId: 'kid-1' }]);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{ id: 'team-1' }]);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([game]);

      await GameService.listGames(baseQuery, parent.id);

      expect(mockPrisma.team.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { staff: { some: { userId: parent.id } } },
            { members: { some: { playerId: parent.id } } },
            { season: { league: { admins: { some: { userId: parent.id } } } } },
            { members: { some: { playerId: { in: ['kid-1'] } } } },
          ],
        },
        select: { id: true },
      });
    });

    it('should allow non-admin to query a specific team they have access to', async () => {
      const coach = createCoach();
      const teamId = 'team-allowed';

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{ id: teamId }, { id: 'other' }]);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([]);

      const result = await GameService.listGames({ ...baseQuery, teamId }, coach.id);

      expect(result.games).toEqual([]);
      const findManyArgs = (mockPrisma.game.findMany as jest.Mock).mock.calls[0][0];
      // teamId stays as the specific string — not replaced with { in: ... }
      expect(findManyArgs.where.teamId).toBe(teamId);
    });

    it('should throw ForbiddenError when non-admin queries a team they cannot access', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{ id: 'team-allowed' }]);

      try {
        await GameService.listGames({ ...baseQuery, teamId: 'team-forbidden' }, coach.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this team');
      }

      // Must not have queried games at all
      expect(mockPrisma.game.findMany).not.toHaveBeenCalled();
    });

    it('should short-circuit with empty results when non-admin has no teams', async () => {
      const player = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);

      const result = await GameService.listGames(baseQuery, player.id);

      expect(result).toEqual({
        games: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      // Should NOT query games when the user has no team access
      expect(mockPrisma.game.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.game.count).not.toHaveBeenCalled();
    });

    it('should apply only startDate when endDate is omitted (and vice versa)', async () => {
      const admin = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([]);

      await GameService.listGames(
        { ...baseQuery, startDate: '2026-01-01T00:00:00Z' },
        admin.id
      );

      const call1 = (mockPrisma.game.findMany as jest.Mock).mock.calls[0][0];
      expect(call1.where.date.gte).toBeInstanceOf(Date);
      expect(call1.where.date.lte).toBeUndefined();

      jest.clearAllMocks();
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(admin);
      (mockPrisma.game.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([]);

      await GameService.listGames(
        { ...baseQuery, endDate: '2026-12-31T00:00:00Z' },
        admin.id
      );

      const call2 = (mockPrisma.game.findMany as jest.Mock).mock.calls[0][0];
      expect(call2.where.date.gte).toBeUndefined();
      expect(call2.where.date.lte).toBeInstanceOf(Date);
    });
  });

  describe('updateGame (extended)', () => {
    const setupCoachWithTrackStatsOnly = (team: ReturnType<typeof createTeam>, coach: ReturnType<typeof createCoach>): void => {
      // canTrackStats=true, canManageTeam=false, canManageRoster=false
      const trackerRole = createTeamRole({
        teamId: team.id,
        type: 'ASSISTANT_COACH',
        canManageTeam: false,
        canManageRoster: false,
        canTrackStats: true,
      });
      const staff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: trackerRole.id });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(staff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...staff, role: trackerRole }]);
    };

    it('should forbid a canTrackStats-only user from changing the status of a FINISHED game (audit #78)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'FINISHED' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);

      const error = await GameService.updateGame(game.id, { status: 'IN_PROGRESS' }, coach.id).catch(
        (e) => e
      );

      expectForbiddenError(error, 'Only roster managers can change the status or score of a finished game');
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
    });

    it('should forbid a canTrackStats-only user from rewriting the score of a FINISHED game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'FINISHED' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);

      const error = await GameService.updateGame(game.id, { homeScore: 99 }, coach.id).catch((e) => e);

      expectForbiddenError(error, 'Only roster managers can change the status or score of a finished game');
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
    });

    it('should allow a roster manager (head coach) to reopen a FINISHED game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, status: 'FINISHED' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        status: 'IN_PROGRESS',
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      const result = await GameService.updateGame(game.id, { status: 'IN_PROGRESS' }, coach.id);

      expect(result.status).toBe('IN_PROGRESS');
    });

    it('should not apply the FINISHED guard when only opponent/date change', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, status: 'FINISHED' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        opponent: 'Renamed',
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      await GameService.updateGame(game.id, { opponent: 'Renamed' }, coach.id);

      // canManageTeam + canTrackStats lookups only — no third canManageRoster round-trip
      expect(mockPrisma.teamStaff.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.game.update).toHaveBeenCalled();
    });

    it('should allow a canTrackStats-only user to update scores during game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        homeScore: 42,
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      const result = await GameService.updateGame(game.id, { homeScore: 42 }, coach.id);
      expect(result.homeScore).toBe(42);
    });

    it('accepts a client homeScore only when the game has no SHOT events (audit #6)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        homeScore: 42,
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      await GameService.updateGame(game.id, { homeScore: 42 }, coach.id);

      expect(mockPrisma.gameEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { gameId: game.id, eventType: 'SHOT' } })
      );
      expect(mockPrisma.game.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { homeScore: 42 } })
      );
    });

    it('ignores a client homeScore and re-persists the event-derived score when SHOT events exist (audit #6)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS', homeScore: 5 });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { eventType: 'SHOT', metadata: { made: true, points: 3 } },
        { eventType: 'SHOT', metadata: { made: true, points: 2 } },
        { eventType: 'SHOT', metadata: { made: false, points: 2 } },
      ]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        homeScore: 5,
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      // Client (stale 100-event page) claims 1; the log says 5.
      await GameService.updateGame(game.id, { homeScore: 1 }, coach.id);

      expect(mockPrisma.game.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { homeScore: 5 } })
      );
    });

    it('emits game-score-change when the away score changes (audit #8)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS', homeScore: 10, awayScore: 8 });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        awayScore: 11,
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      await GameService.updateGame(game.id, { awayScore: 11 }, coach.id);

      expect(mockEmitGameScoreChange).toHaveBeenCalledWith(game.id, {
        gameId: game.id,
        score: { homeScore: 10, awayScore: 11 },
      });
      expect(mockEmitGameStatusChange).not.toHaveBeenCalled();
    });

    it('does not emit game-score-change when the score is unchanged', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, homeScore: 10, awayScore: 8 });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        opponent: 'Renamed',
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      await GameService.updateGame(game.id, { opponent: 'Renamed' }, coach.id);

      expect(mockEmitGameScoreChange).not.toHaveBeenCalled();
    });

    it('should forbid a canTrackStats-only user from updating non-score fields', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);

      try {
        await GameService.updateGame(game.id, { opponent: 'Renamed' }, coach.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to update this game');
      }

      expect(mockPrisma.game.update).not.toHaveBeenCalled();
    });

    it('should finalize stats and set status when marking game FINISHED', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const staff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...staff, role: headCoachRole }]);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        status: 'FINISHED',
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      const result = await GameService.updateGame(game.id, { status: 'FINISHED' }, coach.id);

      expect(result.status).toBe('FINISHED');
      // finalizeGameStats fetches game + events to compute. We don't assert
      // persistence here (already covered by StatsService tests) but confirm
      // the FINISHED branch did not throw.
    });

    it('should swallow errors from finalizeGameStats and still return updated game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const staff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockImplementation(() => {
        // First call returns the original game for the permission check;
        // finalizeGameStats' internal lookup will see null and throw a
        // NotFoundError which must be caught by updateGame.
        const callCount = (mockPrisma.game.findUnique as jest.Mock).mock.calls.length;
        return Promise.resolve(callCount === 1 ? game : null);
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...staff, role: headCoachRole }]);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        status: 'FINISHED',
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      const result = await GameService.updateGame(game.id, { status: 'FINISHED' }, coach.id);

      // The finalize error is swallowed — update should still succeed
      expect(result.status).toBe('FINISHED');
    });
  });
});
