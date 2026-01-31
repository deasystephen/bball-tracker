/**
 * Unit tests for GameEventService
 */

import { GameEventService } from '../../src/services/game-event-service';
import { mockPrisma } from '../setup';
import {
  createGame,
  createTeam,
  createCoach,
  createSeason,
  createLeague,
  createPlayer,
  createTeamMember,
  createGameEvent,
  createTeamRole,
  createTeamStaff,
} from '../factories';
import { expectNotFoundError, expectForbiddenError } from '../helpers';

describe('GameEventService', () => {
  describe('createEvent', () => {
    it('should create an event when user has canTrackStats permission', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const player = createPlayer();
      createTeamMember({ teamId: team.id, playerId: player.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [{ playerId: player.id }],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      // canAccessTeam uses findFirst
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      // getTeamPermissions uses findMany
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      const result = await GameEventService.createEvent(
        game.id,
        { playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 2 } },
        coach.id
      );

      expect(result).toHaveProperty('id', event.id);
      expect(result).toHaveProperty('eventType', 'SHOT');
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.createEvent(
          'non-existent',
          { eventType: 'SHOT', metadata: { made: true, points: 2 } },
          'coach-id'
        );
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user does not have canTrackStats permission', async () => {
      // Player has team access as a member but doesn't have canTrackStats permission
      const playerUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });
      const member = createTeamMember({ teamId: team.id, playerId: playerUser.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [{ playerId: playerUser.id }],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(playerUser);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      // canAccessTeam: not staff
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      // canAccessTeam: is a team member - grants access
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(member);
      // getTeamPermissions: no staff roles
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);

      try {
        await GameEventService.createEvent(
          game.id,
          { eventType: 'SHOT', metadata: { made: true, points: 2 } },
          playerUser.id
        );
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to create game events');
      }
    });

    it('should throw ForbiddenError if player is not on team', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const otherPlayer = createPlayer();
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [], // Player not on team
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      // canAccessTeam: is staff
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      // getTeamPermissions: has canTrackStats
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);

      try {
        await GameEventService.createEvent(
          game.id,
          { playerId: otherPlayer.id, eventType: 'SHOT', metadata: { made: true, points: 2 } },
          coach.id
        );
      } catch (error) {
        expectForbiddenError(error, 'Player is not a member of this team');
      }
    });
  });

  describe('listEvents', () => {
    it('should return events for authorized user', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const player = createPlayer();
      const game = createGame({ teamId: team.id });
      const event1 = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });
      const event2 = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { ...event1, player: { id: player.id, name: player.name } },
        { ...event2, player: { id: player.id, name: player.name } },
      ]);

      const result = await GameEventService.listEvents(
        game.id,
        { limit: 10, offset: 0 },
        coach.id
      );

      expect(result.events).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  describe('getEventById', () => {
    it('should return event for authorized user', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const player = createPlayer();
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      const result = await GameEventService.getEventById(game.id, event.id, coach.id);

      expect(result).toHaveProperty('id', event.id);
    });

    it('should throw NotFoundError if event does not exist', async () => {
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
          members: [],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.getEventById(game.id, 'non-existent', coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Game event not found');
      }
    });
  });

  describe('deleteEvent', () => {
    it('should delete event when user has canTrackStats permission', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const player = createPlayer();
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);
      (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue(event);

      const result = await GameEventService.deleteEvent(game.id, event.id, coach.id);

      expect(result).toEqual({ success: true });
    });

    it('should throw NotFoundError if event does not exist', async () => {
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
          members: [],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{
        ...coachStaff,
        role: headCoachRole,
      }]);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.deleteEvent(game.id, 'non-existent', coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Game event not found');
      }
    });

    it('should throw ForbiddenError if user does not have canTrackStats permission', async () => {
      const otherUser = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          members: [],
        },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(otherUser);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });

      try {
        await GameEventService.deleteEvent(game.id, event.id, otherUser.id);
      } catch (error) {
        expectForbiddenError(error, 'You do not have permission to delete game events');
      }
    });
  });
});
