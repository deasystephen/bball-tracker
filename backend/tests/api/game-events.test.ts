/**
 * Game Events API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { GameEventService } from '../../src/services/game-event-service';
import { NotFoundError, ForbiddenError } from '../../src/utils/errors';

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_GAME_ID = 'c3d4e5f6-a7b8-9012-3456-7890abcdef01';
const TEST_EVENT_ID = 'd4e5f6a7-b8c9-0123-4567-890abcdef012';
const TEST_PLAYER_ID = 'e5f6a7b8-c9d0-1234-5678-90abcdef0123';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the service
jest.mock('../../src/services/game-event-service');

const mockGameEventService = GameEventService as jest.Mocked<typeof GameEventService>;

describe('Game Events API', () => {
  const mockEvent = {
    id: TEST_EVENT_ID,
    gameId: TEST_GAME_ID,
    playerId: TEST_PLAYER_ID,
    eventType: 'SHOT',
    timestamp: new Date('2024-03-15T18:30:00Z'),
    metadata: { made: true, points: 2 },
    createdAt: new Date(),
    player: { id: TEST_PLAYER_ID, name: 'Test Player' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/games/:gameId/events', () => {
    it('should create an event successfully', async () => {
      mockGameEventService.createEvent.mockResolvedValue(mockEvent as any);

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({
          playerId: TEST_PLAYER_ID,
          eventType: 'SHOT',
          metadata: { made: true, points: 2 },
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.event).toBeDefined();
      expect(response.body.event.eventType).toBe('SHOT');
      expect(mockGameEventService.createEvent).toHaveBeenCalledWith(
        TEST_GAME_ID,
        expect.objectContaining({
          playerId: TEST_PLAYER_ID,
          eventType: 'SHOT',
        }),
        TEST_USER_ID
      );
    });

    it('should create an event without playerId (timeout)', async () => {
      const timeoutEvent = { ...mockEvent, playerId: null, eventType: 'TIMEOUT', metadata: { type: 'full' } };
      mockGameEventService.createEvent.mockResolvedValue(timeoutEvent as any);

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({
          eventType: 'TIMEOUT',
          metadata: { type: 'full' },
        });

      expect(response.status).toBe(201);
      expect(response.body.event.eventType).toBe('TIMEOUT');
    });

    it('should return 400 for missing eventType', async () => {
      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for invalid eventType', async () => {
      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({
          playerId: TEST_PLAYER_ID,
          eventType: 'INVALID_TYPE',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid event type');
    });

    it('should return 400 for invalid playerId format', async () => {
      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({
          playerId: 'not-a-uuid',
          eventType: 'SHOT',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid player ID format');
    });

    it('should return 404 when game not found', async () => {
      mockGameEventService.createEvent.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({
          eventType: 'SHOT',
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game not found');
    });

    it('should return 403 when user has no access', async () => {
      mockGameEventService.createEvent.mockRejectedValue(
        new ForbiddenError('You do not have access to this game')
      );

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/events`)
        .send({
          eventType: 'SHOT',
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('You do not have access to this game');
    });
  });

  describe('GET /api/v1/games/:gameId/events', () => {
    it('should list events successfully', async () => {
      mockGameEventService.listEvents.mockResolvedValue({
        events: [mockEvent],
        total: 1,
        limit: 50,
        offset: 0,
      } as any);

      const response = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/events`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.events).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });

    it('should filter events by eventType', async () => {
      mockGameEventService.listEvents.mockResolvedValue({
        events: [mockEvent],
        total: 1,
        limit: 50,
        offset: 0,
      } as any);

      const response = await request(app)
        .get(`/api/v1/games/${TEST_GAME_ID}/events`)
        .query({ eventType: 'SHOT' });

      expect(response.status).toBe(200);
      expect(mockGameEventService.listEvents).toHaveBeenCalledWith(
        TEST_GAME_ID,
        expect.objectContaining({ eventType: 'SHOT' }),
        TEST_USER_ID
      );
    });

    it('should filter events by playerId', async () => {
      mockGameEventService.listEvents.mockResolvedValue({
        events: [mockEvent],
        total: 1,
        limit: 50,
        offset: 0,
      } as any);

      const response = await request(app)
        .get(`/api/v1/games/${TEST_GAME_ID}/events`)
        .query({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(200);
      expect(mockGameEventService.listEvents).toHaveBeenCalledWith(
        TEST_GAME_ID,
        expect.objectContaining({ playerId: TEST_PLAYER_ID }),
        TEST_USER_ID
      );
    });

    it('should support pagination', async () => {
      mockGameEventService.listEvents.mockResolvedValue({
        events: [mockEvent],
        total: 100,
        limit: 10,
        offset: 20,
      } as any);

      const response = await request(app)
        .get(`/api/v1/games/${TEST_GAME_ID}/events`)
        .query({ limit: 10, offset: 20 });

      expect(response.status).toBe(200);
      expect(response.body.limit).toBe(10);
      expect(response.body.offset).toBe(20);
      expect(response.body.total).toBe(100);
    });

    it('should return 404 when game not found', async () => {
      mockGameEventService.listEvents.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/events`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game not found');
    });

    it('should return 403 when user has no access', async () => {
      mockGameEventService.listEvents.mockRejectedValue(
        new ForbiddenError('You do not have access to this game')
      );

      const response = await request(app).get(`/api/v1/games/${TEST_GAME_ID}/events`);

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/games/:gameId/events/:eventId', () => {
    it('should get an event by ID', async () => {
      mockGameEventService.getEventById.mockResolvedValue(mockEvent as any);

      const response = await request(app).get(
        `/api/v1/games/${TEST_GAME_ID}/events/${TEST_EVENT_ID}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.event.id).toBe(TEST_EVENT_ID);
      expect(response.body.event.eventType).toBe('SHOT');
    });

    it('should return 404 for non-existent event', async () => {
      mockGameEventService.getEventById.mockRejectedValue(
        new NotFoundError('Game event not found')
      );

      const response = await request(app).get(
        `/api/v1/games/${TEST_GAME_ID}/events/00000000-0000-0000-0000-000000000000`
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game event not found');
    });

    it('should return 403 for forbidden access', async () => {
      mockGameEventService.getEventById.mockRejectedValue(
        new ForbiddenError('You do not have access to this game')
      );

      const response = await request(app).get(
        `/api/v1/games/${TEST_GAME_ID}/events/${TEST_EVENT_ID}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/games/:gameId/events/:eventId', () => {
    it('should delete an event successfully', async () => {
      mockGameEventService.deleteEvent.mockResolvedValue({ success: true });

      const response = await request(app).delete(
        `/api/v1/games/${TEST_GAME_ID}/events/${TEST_EVENT_ID}`
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Game event deleted successfully');
      expect(mockGameEventService.deleteEvent).toHaveBeenCalledWith(
        TEST_GAME_ID,
        TEST_EVENT_ID,
        TEST_USER_ID
      );
    });

    it('should return 404 for non-existent event', async () => {
      mockGameEventService.deleteEvent.mockRejectedValue(
        new NotFoundError('Game event not found')
      );

      const response = await request(app).delete(
        `/api/v1/games/${TEST_GAME_ID}/events/00000000-0000-0000-0000-000000000000`
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game event not found');
    });

    it('should return 403 for non-coach user', async () => {
      mockGameEventService.deleteEvent.mockRejectedValue(
        new ForbiddenError('Only the team coach can delete game events')
      );

      const response = await request(app).delete(
        `/api/v1/games/${TEST_GAME_ID}/events/${TEST_EVENT_ID}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Only the team coach can delete game events');
    });

    it('should return 404 when game not found', async () => {
      mockGameEventService.deleteEvent.mockRejectedValue(new NotFoundError('Game not found'));

      const response = await request(app).delete(
        `/api/v1/games/${TEST_GAME_ID}/events/${TEST_EVENT_ID}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Game not found');
    });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
