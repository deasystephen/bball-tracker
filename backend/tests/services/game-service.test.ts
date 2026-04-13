/**
 * Unit tests for GameService
 */

import { GameService } from '../../src/services/game-service';
import { mockPrisma } from '../setup';
import {
  createAdmin,
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
import { expectNotFoundError, expectForbiddenError } from '../helpers';

// Helper to create valid game input
const createGameInput = (overrides: {
  teamId: string;
  opponent: string;
  date: Date | string;
  status?: 'SCHEDULED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';
  homeScore?: number;
  awayScore?: number;
}) => ({
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
    it('should return game for staff member', async () => {
      const coach = createCoach();
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
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);

      const result = await GameService.getGameById(game.id, coach.id);

      expect(result).toHaveProperty('id', game.id);
    });

    it('should return game for team member', async () => {
      const coach = createCoach();
      const player = createPlayer();
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
          members: [{ ...member, playerId: player.id }],
        },
        events: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);

      const result = await GameService.getGameById(game.id, player.id);

      expect(result).toHaveProperty('id', game.id);
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
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await GameService.updateGame(game.id, { opponent: 'New Opponent' }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to update this game');
      }
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
      // canTrackStats=true, canManageTeam=false
      const trackerRole = createTeamRole({
        teamId: team.id,
        type: 'ASSISTANT_COACH',
        canManageTeam: false,
        canTrackStats: true,
      });
      const staff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: trackerRole.id });
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...staff, role: trackerRole }]);
    };

    it('should allow a canTrackStats-only user to update scores during game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(game);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      setupCoachWithTrackStatsOnly(team, coach);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({
        ...game,
        homeScore: 42,
        team: { ...team, season: { ...season, league }, staff: [] },
      });

      const result = await GameService.updateGame(game.id, { homeScore: 42 }, coach.id);
      expect(result.homeScore).toBe(42);
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
