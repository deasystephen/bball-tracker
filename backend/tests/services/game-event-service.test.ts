/**
 * Unit tests for GameEventService
 */

import { GameEventService } from '../../src/services/game-event-service';
import { mockPrisma } from '../setup';
import {
  createGame,
  createTeam,
  createCoach,
  createLeague,
  createPlayer,
  createGameEvent,
} from '../factories';
import { expectNotFoundError, expectForbiddenError } from '../helpers';

describe('GameEventService', () => {
  describe('createEvent', () => {
    it('should create an event successfully as coach', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const team = createTeam({ coachId: coach.id, leagueId: league.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({
        gameId: game.id,
        playerId: player.id,
        eventType: 'SHOT',
        metadata: { made: true, points: 2 },
      });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [{ playerId: player.id }],
        },
      });
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      const result = await GameEventService.createEvent(
        game.id,
        {
          playerId: player.id,
          eventType: 'SHOT',
          metadata: { made: true, points: 2 },
        },
        coach.id
      );

      expect(result).toHaveProperty('id', event.id);
      expect(result).toHaveProperty('eventType', 'SHOT');
      expect(mockPrisma.gameEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gameId: game.id,
            playerId: player.id,
            eventType: 'SHOT',
          }),
        })
      );
    });

    it('should create an event successfully as team member', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const league = createLeague();
      const team = createTeam({ coachId: coach.id, leagueId: league.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({
        gameId: game.id,
        playerId: player.id,
        eventType: 'REBOUND',
      });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [{ playerId: player.id }],
        },
      });
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      const result = await GameEventService.createEvent(
        game.id,
        {
          playerId: player.id,
          eventType: 'REBOUND',
          metadata: { offensive: false },
        },
        player.id
      );

      expect(result).toHaveProperty('eventType', 'REBOUND');
    });

    it('should create an event without playerId (e.g., timeout)', async () => {
      const coach = createCoach();
      const league = createLeague();
      const team = createTeam({ coachId: coach.id, leagueId: league.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({
        gameId: game.id,
        playerId: null,
        eventType: 'TIMEOUT',
        metadata: { type: 'full' },
      });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.create as jest.Mock).mockResolvedValue({
        ...event,
        player: null,
      });

      const result = await GameEventService.createEvent(
        game.id,
        {
          eventType: 'TIMEOUT',
          metadata: { type: 'full' },
        },
        coach.id
      );

      expect(result).toHaveProperty('eventType', 'TIMEOUT');
      expect((result as any).player).toBeNull();
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.createEvent(
          'non-existent',
          { eventType: 'SHOT', metadata: {} },
          'user-id'
        );
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const coach = createCoach();
      const otherUser = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });

      try {
        await GameEventService.createEvent(
          game.id,
          { eventType: 'SHOT', metadata: {} },
          otherUser.id
        );
        fail('Expected ForbiddenError to be thrown');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this game');
      }
    });

    it('should throw ForbiddenError if playerId is not on team', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const otherPlayer = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [{ playerId: player.id }],
        },
      });

      try {
        await GameEventService.createEvent(
          game.id,
          { playerId: otherPlayer.id, eventType: 'SHOT', metadata: {} },
          coach.id
        );
        fail('Expected ForbiddenError to be thrown');
      } catch (error) {
        expectForbiddenError(error, 'Player is not a member of this team');
      }
    });
  });

  describe('listEvents', () => {
    it('should return events for a game', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });
      const event1 = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });
      const event2 = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'REBOUND' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { ...event1, player: { id: player.id, name: player.name } },
        { ...event2, player: { id: player.id, name: player.name } },
      ]);

      const result = await GameEventService.listEvents(
        game.id,
        { limit: 50, offset: 0 },
        coach.id
      );

      expect(result.events).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter by eventType', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { ...event, player: { id: player.id, name: player.name } },
      ]);

      const result = await GameEventService.listEvents(
        game.id,
        { eventType: 'SHOT', limit: 50, offset: 0 },
        coach.id
      );

      expect(result.events).toHaveLength(1);
      expect(result.events[0].eventType).toBe('SHOT');
    });

    it('should filter by playerId', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([
        { ...event, player: { id: player.id, name: player.name } },
      ]);

      const result = await GameEventService.listEvents(
        game.id,
        { playerId: player.id, limit: 50, offset: 0 },
        coach.id
      );

      expect(result.events).toHaveLength(1);
    });

    it('should support pagination', async () => {
      const coach = createCoach();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.count as jest.Mock).mockResolvedValue(50);
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);

      const result = await GameEventService.listEvents(
        game.id,
        { limit: 10, offset: 20 },
        coach.id
      );

      expect(result.total).toBe(50);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
      expect(mockPrisma.gameEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        })
      );
    });

    it('should throw NotFoundError if game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.listEvents(
          'non-existent',
          { limit: 50, offset: 0 },
          'user-id'
        );
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expectNotFoundError(error, 'Game not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const coach = createCoach();
      const otherUser = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });

      try {
        await GameEventService.listEvents(
          game.id,
          { limit: 50, offset: 0 },
          otherUser.id
        );
        fail('Expected ForbiddenError to be thrown');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this game');
      }
    });
  });

  describe('getEventById', () => {
    it('should return an event by ID', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue({
        ...event,
        player: { id: player.id, name: player.name },
      });

      const result = await GameEventService.getEventById(game.id, event.id, coach.id);

      expect(result).toHaveProperty('id', event.id);
      expect(result).toHaveProperty('eventType', 'SHOT');
    });

    it('should throw NotFoundError if event does not exist', async () => {
      const coach = createCoach();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.getEventById(game.id, 'non-existent', coach.id);
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expectNotFoundError(error, 'Game event not found');
      }
    });

    it('should throw NotFoundError if event belongs to different game', async () => {
      const coach = createCoach();
      const team = createTeam({ coachId: coach.id });
      const game1 = createGame({ teamId: team.id });
      const game2 = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game2.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game1,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);

      try {
        await GameEventService.getEventById(game1.id, event.id, coach.id);
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expectNotFoundError(error, 'Game event not found');
      }
    });

    it('should throw ForbiddenError if user has no access', async () => {
      const coach = createCoach();
      const otherUser = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });

      try {
        await GameEventService.getEventById(game.id, 'event-id', otherUser.id);
        fail('Expected ForbiddenError to be thrown');
      } catch (error) {
        expectForbiddenError(error, 'You do not have access to this game');
      }
    });
  });

  describe('deleteEvent', () => {
    it('should delete event successfully as coach', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, playerId: player.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);
      (mockPrisma.gameEvent.delete as jest.Mock).mockResolvedValue(event);

      const result = await GameEventService.deleteEvent(game.id, event.id, coach.id);

      expect(result).toEqual({ success: true });
      expect(mockPrisma.gameEvent.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: event.id },
        })
      );
    });

    it('should throw ForbiddenError if user is not coach', async () => {
      const coach = createCoach();
      const player = createPlayer();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [{ playerId: player.id }],
        },
      });

      try {
        await GameEventService.deleteEvent(game.id, event.id, player.id);
        fail('Expected ForbiddenError to be thrown');
      } catch (error) {
        expectForbiddenError(error, 'Only the team coach can delete game events');
      }
    });

    it('should throw NotFoundError if event does not exist', async () => {
      const coach = createCoach();
      const team = createTeam({ coachId: coach.id });
      const game = createGame({ teamId: team.id });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await GameEventService.deleteEvent(game.id, 'non-existent', coach.id);
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expectNotFoundError(error, 'Game event not found');
      }
    });

    it('should throw NotFoundError if event belongs to different game', async () => {
      const coach = createCoach();
      const team = createTeam({ coachId: coach.id });
      const game1 = createGame({ teamId: team.id });
      const game2 = createGame({ teamId: team.id });
      const event = createGameEvent({ gameId: game2.id, eventType: 'SHOT' });

      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue({
        ...game1,
        team: {
          ...team,
          coachId: coach.id,
          members: [],
        },
      });
      (mockPrisma.gameEvent.findUnique as jest.Mock).mockResolvedValue(event);

      try {
        await GameEventService.deleteEvent(game1.id, event.id, coach.id);
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expectNotFoundError(error, 'Game event not found');
      }
    });
  });
});
