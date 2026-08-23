/**
 * Unit tests for GameEventService
 */

import { GameEventService, computeHomeScore } from '../../src/services/game-event-service';
import { StatsService } from '../../src/services/stats-service';
import { emitGameEvent, emitGameEventRemoved } from '../../src/websocket/emit';
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
  createUser,
} from '../factories';
import { expectNotFoundError, expectForbiddenError } from '../helpers';

jest.mock('../../src/websocket/emit', () => ({
  emitGameEvent: jest.fn(),
  emitGameEventRemoved: jest.fn(),
}));

const mockEmitGameEvent = emitGameEvent as jest.Mock;
const mockEmitGameEventRemoved = emitGameEventRemoved as jest.Mock;

describe('GameEventService', () => {
  let finalizeSpy: jest.SpyInstance;

  beforeEach(() => {
    finalizeSpy = jest.spyOn(StatsService, 'finalizeGameStats').mockResolvedValue();
  });

  afterEach(() => {
    finalizeSpy.mockRestore();
  });

  /** Mocks every lookup needed for a head coach to create/delete an event on `game`. */
  function mockCoachAccess(game: ReturnType<typeof createGame>, playerId?: string): { coachId: string } {
    const coach = createCoach();
    const league = createLeague();
    const season = createSeason({ leagueId: league.id });
    const team = createTeam({ id: game.teamId, seasonId: season.id });
    const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
    const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });

    (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
      ...game,
      team: { ...team, members: playerId ? [{ playerId }] : [] },
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
      ...team,
      season: { ...season, league: { ...league, admins: [] } },
    });
    (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
    (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
    // SHOT create/delete recompute the score inside a transaction (audit #6)
    (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.game.update as jest.Mock).mockResolvedValue({ homeScore: 0, awayScore: 0 });
    return { coachId: coach.id };
  }

  describe('re-finalizing FINISHED games (audit #27)', () => {
    it('createEvent on a FINISHED game re-runs finalizeGameStats', async () => {
      const player = createPlayer();
      const game = createGame({ status: 'FINISHED' });
      const { coachId } = mockCoachAccess(game, player.id);
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      await GameEventService.createEvent(
        game.id,
        { playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 2 } },
        coachId
      );

      expect(finalizeSpy).toHaveBeenCalledWith(game.id);
    });

    it('createEvent on an IN_PROGRESS game does not finalize', async () => {
      const player = createPlayer();
      const game = createGame({ status: 'IN_PROGRESS' });
      const { coachId } = mockCoachAccess(game, player.id);
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      await GameEventService.createEvent(
        game.id,
        { playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 2 } },
        coachId
      );

      expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it('deleteEvent on a FINISHED game re-runs finalizeGameStats', async () => {
      const game = createGame({ status: 'FINISHED' });
      const { coachId } = mockCoachAccess(game);
      const event = createGameEvent({ gameId: game.id, eventType: 'SHOT' });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);
      (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue(event);

      await GameEventService.deleteEvent(game.id, event.id, coachId);

      expect(finalizeSpy).toHaveBeenCalledWith(game.id);
    });

    it('deleteEvent on an IN_PROGRESS game does not finalize', async () => {
      const game = createGame({ status: 'IN_PROGRESS' });
      const { coachId } = mockCoachAccess(game);
      const event = createGameEvent({ gameId: game.id, eventType: 'SHOT' });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);
      (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue(event);

      await GameEventService.deleteEvent(game.id, event.id, coachId);

      expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it('a finalize failure is logged and does not fail the event write', async () => {
      finalizeSpy.mockRejectedValue(new Error('db down'));
      const game = createGame({ status: 'FINISHED' });
      const { coachId } = mockCoachAccess(game);
      const event = createGameEvent({ gameId: game.id, eventType: 'SHOT' });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);
      (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue(event);

      await expect(GameEventService.deleteEvent(game.id, event.id, coachId)).resolves.toMatchObject({ success: true });
    });
  });

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
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { eventType: 'SHOT', metadata: { made: true, points: 2 } },
      ]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({ homeScore: 2, awayScore: 0 });

      const result = await GameEventService.createEvent(
        game.id,
        { playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 2 } },
        coach.id
      );

      expect(result.event).toHaveProperty('id', event.id);
      expect(result.event).toHaveProperty('eventType', 'SHOT');
      expect(result.score).toEqual({ homeScore: 2, awayScore: 0 });
    });

    it('should recompute and persist homeScore from SHOT events inside a transaction (audit #6, #8)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const player = createPlayer();
      // Stale client-written score: the server must not trust it.
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS', homeScore: 1, awayScore: 7 });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [{ playerId: player.id }] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({ ...event, player: null });
      // 101 prior made 2s + the new made 3 — more than the client's 100-event page.
      const priorShots = Array.from({ length: 101 }, () => ({
        eventType: 'SHOT',
        metadata: { made: true, points: 2 },
      }));
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        ...priorShots,
        { eventType: 'SHOT', metadata: { made: true, points: 3 } },
        { eventType: 'SHOT', metadata: { made: false, points: 3 } },
      ]);
      (mockPrisma.game.update as jest.Mock).mockImplementation(
        async (args: { data: { homeScore: number } }) => ({
          homeScore: args.data.homeScore,
          awayScore: 7,
        })
      );

      const result = await GameEventService.createEvent(
        game.id,
        { playerId: player.id, eventType: 'SHOT', metadata: { made: true, points: 3 } },
        coach.id
      );

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Row lock before reading the log
      const lockSql = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0].join('?');
      expect(lockSql).toContain('FOR UPDATE');
      expect(mockPrisma.gameEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { gameId: game.id, eventType: 'SHOT' } })
      );
      expect(mockPrisma.game.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: game.id }, data: { homeScore: 205 } })
      );
      expect(result.score).toEqual({ homeScore: 205, awayScore: 7 });
      // Broadcast carries the post-insert score, not the stale row
      expect(mockEmitGameEvent).toHaveBeenCalledWith(game.id, {
        event: { ...event, player: null },
        score: { homeScore: 205, awayScore: 7 },
      });
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        GameEventService.createEvent(
          'non-existent',
          { eventType: 'SHOT', metadata: { made: true, points: 2 } },
          'coach-id'
        )
      ).rejects.toMatchObject({ statusCode: 404, message: 'Game not found' });
    });

    it('should throw ForbiddenError if user has no access to the game', async () => {
      const outsider = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(outsider);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      // Not staff, not a member → canAccessTeam returns false
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        GameEventService.createEvent(
          game.id,
          { eventType: 'SHOT', metadata: { made: true, points: 2 } },
          outsider.id
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        message: 'You do not have access to this game',
      });
    });

    it('should create an event with no playerId and a string timestamp', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });
      const event = createGameEvent({ gameId: game.id, eventType: 'TIMEOUT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({ ...event, player: null });

      const result = await GameEventService.createEvent(
        game.id,
        { eventType: 'TIMEOUT', timestamp: '2026-01-02T10:00:00.000Z', metadata: {} },
        coach.id
      );

      expect(result.event).toHaveProperty('id', event.id);
      const createArgs = (mockPrisma.gameEvent.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.playerId).toBeNull();
      expect(createArgs.data.timestamp).toBeInstanceOf(Date);
      // Non-SHOT events don't touch the score, so no transaction/recompute
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
      expect(result.score).toEqual({ homeScore: game.homeScore, awayScore: game.awayScore });
      expect(mockEmitGameEvent).toHaveBeenCalledWith(game.id, {
        event: { ...event, player: null },
        score: { homeScore: game.homeScore, awayScore: game.awayScore },
      });
    });

    it('should default timestamp to now when omitted', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });
      const event = createGameEvent({ gameId: game.id, eventType: 'TIMEOUT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({ ...event, player: null });

      await GameEventService.createEvent(game.id, { eventType: 'TIMEOUT', metadata: {} }, coach.id);

      const createArgs = (mockPrisma.gameEvent.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.timestamp).toBeInstanceOf(Date);
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

    it('should throw ForbiddenError when a guardian (PARENT role) tries to record an event', async () => {
      // Guardian of a rostered child: canAccessTeam is true, canTrackStats is false
      const parent = createUser({ role: 'PARENT' });
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const game = createGame({ teamId: team.id, status: 'IN_PROGRESS' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [{ playerId: 'child-1' }] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(parent);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamMember.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
      // guardian of a current member
      (mockPrisma.guardian.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'g-1' });

      await expect(
        GameEventService.createEvent(
          game.id,
          { playerId: 'child-1', eventType: 'SHOT', metadata: { made: true, points: 2 } },
          parent.id
        )
      ).rejects.toMatchObject({ statusCode: 403, message: 'You do not have permission to create game events' });
      expect(mockPrisma.gameEvent.create).not.toHaveBeenCalled();
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

    it('should apply eventType and playerId filters to the where clause', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const player = createPlayer();
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);

      await GameEventService.listEvents(
        game.id,
        { limit: 5, offset: 0, eventType: 'SHOT', playerId: player.id },
        coach.id
      );

      const findArgs = (mockPrisma.gameEvent.findMany as jest.Mock).mock.calls[0][0];
      expect(findArgs.where).toMatchObject({
        gameId: game.id,
        eventType: 'SHOT',
        playerId: player.id,
      });
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

    it('should throw NotFoundError if event belongs to a different game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: 'some-other-game', eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue(coachStaff);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue({
        ...event,
        player: null,
      });

      await expect(
        GameEventService.getEventById(game.id, event.id, coach.id)
      ).rejects.toMatchObject({ statusCode: 404, message: 'Game event not found' });
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
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { eventType: 'SHOT', metadata: { made: true, points: 3 } },
      ]);
      (mockPrisma.game.update as jest.Mock).mockResolvedValue({ homeScore: 3, awayScore: 5 });

      const result = await GameEventService.deleteEvent(game.id, event.id, coach.id);

      expect(result).toEqual({ success: true, score: { homeScore: 3, awayScore: 5 } });
      // SHOT removal recomputes the score in a transaction and broadcasts it (audit #8)
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.gameEvent.delete).toHaveBeenCalledWith({ where: { id: event.id } });
      expect(mockPrisma.game.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: game.id }, data: { homeScore: 3 } })
      );
      expect(mockEmitGameEventRemoved).toHaveBeenCalledWith(game.id, {
        gameId: game.id,
        eventId: event.id,
        score: { homeScore: 3, awayScore: 5 },
      });
    });

    it('should delete a non-SHOT event without recomputing the score', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id, homeScore: 12, awayScore: 9 });
      const event = createGameEvent({ gameId: game.id, eventType: 'REBOUND' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({ ...game, team: { ...team, members: [] } });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);
      (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue(event);

      const result = await GameEventService.deleteEvent(game.id, event.id, coach.id);

      expect(result).toEqual({ success: true, score: { homeScore: 12, awayScore: 9 } });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.game.update).not.toHaveBeenCalled();
      expect(mockEmitGameEventRemoved).toHaveBeenCalledWith(game.id, {
        gameId: game.id,
        eventId: event.id,
        score: { homeScore: 12, awayScore: 9 },
      });
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

    it('should throw NotFoundError if the event belongs to a different game', async () => {
      const coach = createCoach();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const headCoachRole = createTeamRole({ teamId: team.id, type: 'HEAD_COACH' });
      const coachStaff = createTeamStaff({ teamId: team.id, userId: coach.id, roleId: headCoachRole.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: 'another-game' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: { ...team, members: [] },
      });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);
      (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([{ ...coachStaff, role: headCoachRole }]);
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
        ...team,
        season: { ...season, league: { ...league, admins: [] } },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);

      await expect(
        GameEventService.deleteEvent(game.id, event.id, coach.id)
      ).rejects.toMatchObject({ statusCode: 404, message: 'Game event not found' });
      expect(mockPrisma.gameEvent.delete).not.toHaveBeenCalled();
    });
  });

  describe('computeHomeScore', () => {
    it('sums made shots using points (default 2) and ignores misses and non-shots', () => {
      expect(
        computeHomeScore([
          { eventType: 'SHOT', metadata: { made: true, points: 3 } },
          { eventType: 'SHOT', metadata: { made: true, points: 2 } },
          { eventType: 'SHOT', metadata: { made: true, points: 1 } },
          { eventType: 'SHOT', metadata: { made: true } },
          { eventType: 'SHOT', metadata: { made: false, points: 3 } },
          { eventType: 'REBOUND', metadata: { type: 'defensive' } },
          { eventType: 'SHOT', metadata: null },
        ])
      ).toBe(8);
    });

    it('returns 0 for an empty log', () => {
      expect(computeHomeScore([])).toBe(0);
    });
  });
});
