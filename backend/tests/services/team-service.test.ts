/**
 * Unit tests for TeamService
 */

import { TeamService } from '../../src/services/team-service';
import { mockPrisma } from '../setup';
import {
  createCoach,
  createPlayer,
  createTeam,
  createSeason,
  createLeague,
  createTeamMember,
  createFullTeam,
  createTeamRole,
  createTeamStaff,
} from '../factories';
import {
  expectNotFoundError,
  expectBadRequestError,
  expectForbiddenError,
} from '../helpers';

describe('TeamService', () => {
  describe('createTeam', () => {
    it('should create a team successfully', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH', name: 'Head Coach' });

      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league,
        teams: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.create as jest.Mock).mockResolvedValue(team);
      (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 3 });
      (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue(headCoachRole);
      (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue(
        createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id })
      );
      // Final findUnique to return the complete team
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ userId: coach.id, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        roles: [headCoachRole],
        members: [],
      });

      const result = await TeamService.createTeam(
        { name: team.name, seasonId: season.id },
        coach.id
      );

      expect(result).toHaveProperty('id', team.id);
      expect(result).toHaveProperty('name', team.name);
    });

    it('should throw NotFoundError if season does not exist', async () => {
      const coach = createCoach();
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        TeamService.createTeam({ name: 'Test Team', seasonId: 'non-existent' }, coach.id)
      ).rejects.toThrow();

      try {
        await TeamService.createTeam({ name: 'Test Team', seasonId: 'non-existent' }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Season not found');
      }
    });

    it('should throw ForbiddenError if user does not exist or is not a coach', async () => {
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });

      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({
        ...season,
        league,
        teams: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.createTeam({ name: 'Test Team', seasonId: season.id }, 'non-existent');
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to create teams in this league');
      }
    });
  });

  describe('getTeamById', () => {
    it('should return team for staff member', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);

      const result = await TeamService.getTeamById(team.id, coach.id);

      expect(result).toHaveProperty('id', team.id);
      expect(mockPrisma.team.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
        })
      );
    });

    it('should return team for team member', async () => {
      const { team, coach, season, league, members, headCoachRole, coachStaff } = createFullTeam({ memberCount: 1 });
      const player = members[0].player;

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [{ playerId: player.id, player: { id: player.id, name: player.name, email: player.email } }],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(player);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(members[0].member);

      const result = await TeamService.getTeamById(team.id, player.id);

      expect(result).toHaveProperty('id', team.id);
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.getTeamById('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
        games: [],
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      // Mock canAccessTeam dependencies
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await TeamService.getTeamById(team.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this team');
      }
    });
  });

  describe('listTeams', () => {
    it('should return teams the user has access to', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: team.id }]) // First call for user teams filter
        .mockResolvedValueOnce([{
          ...team,
          season: { ...season, league },
          staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
          members: [],
        }]);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);

      const result = await TeamService.listTeams({ limit: 10, offset: 0 }, coach.id);

      expect(result.teams).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should return empty result if user has no teams', async () => {
      const user = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(user);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValueOnce([]);

      const result = await TeamService.listTeams({ limit: 10, offset: 0 }, user.id);

      expect(result.teams).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should filter by seasonId', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{
        ...team,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
      }]);

      const result = await TeamService.listTeams(
        { seasonId: season.id, limit: 10, offset: 0 },
        coach.id
      );

      expect(result.teams).toHaveLength(1);
    });
  });

  describe('updateTeam', () => {
    it('should update team name when user has canManageTeam permission', async () => {
      const { team, coach, season, league, headCoachRole, coachStaff } = createFullTeam();
      const newName = 'Updated Team Name';

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.update as jest.Mock).mockResolvedValue({
        ...team,
        name: newName,
        season: { ...season, league },
        staff: [{ ...coachStaff, user: { id: coach.id, name: coach.name, email: coach.email }, role: headCoachRole }],
        members: [],
      });

      const result = await TeamService.updateTeam(team.id, { name: newName }, coach.id);

      expect(result).toHaveProperty('name', newName);
      expect(mockPrisma.team.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
          data: expect.objectContaining({ name: newName }),
        })
      );
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeam('non-existent', { name: 'New Name' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageTeam permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.updateTeam(team.id, { name: 'New Name' }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to update this team');
      }
    });

    it('should throw NotFoundError if updating to non-existent season', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeam(team.id, { seasonId: 'non-existent' }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Season not found');
      }
    });
  });

  describe('deleteTeam', () => {
    it('should delete team successfully when user has canManageTeam permission', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.delete as jest.Mock).mockResolvedValue(team);

      const result = await TeamService.deleteTeam(team.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.team.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: team.id },
        })
      );
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.deleteTeam('non-existent', 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageTeam permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.deleteTeam(team.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to delete this team');
      }
    });
  });

  describe('addPlayer', () => {
    it('should add player to team successfully', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.create as jest.Mock).mockResolvedValue({
        ...member,
        player: { id: player.id, name: player.name, email: player.email },
        team: { id: team.id, name: team.name },
      });

      const result = await TeamService.addPlayer(
        team.id,
        { playerId: player.id, jerseyNumber: 10, position: 'Guard' },
        coach.id
      );

      expect(result).toHaveProperty('playerId', player.id);
      expect(mockPrisma.teamMember.create).toHaveBeenCalled();
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.addPlayer('non-existent', { playerId: 'player-id' }, 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.addPlayer(team.id, { playerId: 'player-id' }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to add players to this team');
      }
    });

    it('should throw NotFoundError if player does not exist', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(null);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);

      try {
        await TeamService.addPlayer(team.id, { playerId: 'non-existent' }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw BadRequestError if player is already on team', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const existingMember = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach)
        .mockResolvedValueOnce(player);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(existingMember);

      try {
        await TeamService.addPlayer(team.id, { playerId: player.id }, coach.id);
      } catch (error) {
        expectBadRequestError(error, 'Player is already on this team');
      }
    });
  });

  describe('removePlayer', () => {
    it('should remove player from team successfully', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);
      (mockPrisma.teamMember.delete as jest.Mock).mockResolvedValue(member);

      const result = await TeamService.removePlayer(team.id, player.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.teamMember.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removePlayer('non-existent', 'player-id', 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.removePlayer(team.id, 'player-id', otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to remove players from this team');
      }
    });

    it('should throw NotFoundError if player is not on team', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.removePlayer(team.id, 'non-existent-player', coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player is not on this team');
      }
    });
  });

  describe('updateTeamMember', () => {
    it('should update team member successfully', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();
      const player = createPlayer();
      const member = createTeamMember({ teamId: team.id, playerId: player.id, jerseyNumber: 10 });

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);
      (mockPrisma.teamMember.update as jest.Mock).mockResolvedValue({
        ...member,
        jerseyNumber: 23,
        position: 'Forward',
        player: { id: player.id, name: player.name, email: player.email },
        team: { id: team.id, name: team.name },
      });

      const result = await TeamService.updateTeamMember(
        team.id,
        player.id,
        { jerseyNumber: 23, position: 'Forward' },
        coach.id
      );

      expect(result).toHaveProperty('jerseyNumber', 23);
      expect(result).toHaveProperty('position', 'Forward');
    });

    it('should throw NotFoundError if team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeamMember('non-existent', 'player-id', { jerseyNumber: 10 }, 'coach-id');
      } catch (error) {
        expectNotFoundError(error, 'Team not found');
      }
    });

    it('should throw ForbiddenError if user does not have canManageRoster permission', async () => {
      const { team } = createFullTeam();
      const otherUser = createPlayer();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { league: { admins: [] } },
      });

      try {
        await TeamService.updateTeamMember(team.id, 'player-id', { jerseyNumber: 10 }, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to update team members');
      }
    });

    it('should throw NotFoundError if player is not on team', async () => {
      const { team, coach, headCoachRole, coachStaff } = createFullTeam();

      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(team);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await TeamService.updateTeamMember(team.id, 'non-existent', { jerseyNumber: 10 }, coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player is not on this team');
      }
    });
  });
});
