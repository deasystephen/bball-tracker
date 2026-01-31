/**
 * Unit tests for GameService
 */

import { GameService } from '../../src/services/game-service';
import { mockPrisma } from '../setup';
import {
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
});
