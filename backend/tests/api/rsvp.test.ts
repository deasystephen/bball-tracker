/**
 * RSVP API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { RsvpService } from '../../src/services/rsvp-service';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_GAME_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

// Mock auth middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: 'PLAYER',
    };
    next();
  }),
}));

jest.mock('../../src/services/rsvp-service');

const mockRsvpService = RsvpService as jest.Mocked<typeof RsvpService>;

describe('RSVP API', () => {
  const mockRsvp = {
    id: 'c3d4e5f6-a7b8-4012-a456-7890abcdef01',
    gameId: TEST_GAME_ID,
    userId: TEST_USER_ID,
    status: 'YES',
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { id: TEST_USER_ID, name: 'Test User', email: 'test@example.com' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/games/:gameId/rsvp', () => {
    it('should create an RSVP with YES status', async () => {
      mockRsvpService.upsertRsvp.mockResolvedValue(mockRsvp as unknown as Awaited<ReturnType<typeof mockRsvpService.upsertRsvp>>);

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'YES' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.rsvp).toBeDefined();
      expect(mockRsvpService.upsertRsvp).toHaveBeenCalledWith(
        TEST_GAME_ID,
        TEST_USER_ID,
        'YES',
        undefined
      );
    });

    it('forwards playerId so a guardian can RSVP for a child (PARENT role)', async () => {
      const childId = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
      mockRsvpService.upsertRsvp.mockResolvedValue({
        ...mockRsvp,
        userId: childId,
        user: { id: childId, name: 'Kid', email: null },
      } as unknown as Awaited<ReturnType<typeof mockRsvpService.upsertRsvp>>);

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'YES', playerId: childId });

      expect(response.status).toBe(200);
      expect(response.body.rsvp.userId).toBe(childId);
      expect(mockRsvpService.upsertRsvp).toHaveBeenCalledWith(TEST_GAME_ID, TEST_USER_ID, 'YES', childId);
    });

    it('returns 400 for a malformed playerId', async () => {
      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'YES', playerId: 'not-a-uuid' });

      expect(response.status).toBe(400);
      expect(mockRsvpService.upsertRsvp).not.toHaveBeenCalled();
    });

    it('returns 403 when the caller is not a guardian of the player', async () => {
      const { ForbiddenError } = jest.requireActual('../../src/utils/errors');
      mockRsvpService.upsertRsvp.mockRejectedValue(
        new ForbiddenError('You can only RSVP for players you are a guardian of')
      );

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'YES', playerId: 'd4e5f6a7-b8c9-4123-a567-890abcdef012' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('You can only RSVP for players you are a guardian of');
    });

    it('should accept NO status', async () => {
      const noRsvp = { ...mockRsvp, status: 'NO' };
      mockRsvpService.upsertRsvp.mockResolvedValue(noRsvp as unknown as Awaited<ReturnType<typeof mockRsvpService.upsertRsvp>>);

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'NO' });

      expect(response.status).toBe(200);
    });

    it('should accept MAYBE status', async () => {
      const maybeRsvp = { ...mockRsvp, status: 'MAYBE' };
      mockRsvpService.upsertRsvp.mockResolvedValue(maybeRsvp as unknown as Awaited<ReturnType<typeof mockRsvpService.upsertRsvp>>);

      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'MAYBE' });

      expect(response.status).toBe(200);
    });

    it('should return 400 for invalid status', async () => {
      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({ status: 'INVALID' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing status', async () => {
      const response = await request(app)
        .post(`/api/v1/games/${TEST_GAME_ID}/rsvp`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid game ID format', async () => {
      const response = await request(app)
        .post('/api/v1/games/not-a-uuid/rsvp')
        .send({ status: 'YES' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/games/:gameId/rsvps', () => {
    it('should return RSVPs with summary', async () => {
      mockRsvpService.getGameRsvps.mockResolvedValue({
        rsvps: [mockRsvp],
        summary: { yes: 1, no: 0, maybe: 0 },
      } as unknown as Awaited<ReturnType<typeof mockRsvpService.getGameRsvps>>);

      const response = await request(app)
        .get(`/api/v1/games/${TEST_GAME_ID}/rsvps`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.rsvps).toHaveLength(1);
      expect(response.body.summary).toEqual({ yes: 1, no: 0, maybe: 0 });
    });

    it('should return 400 for invalid game ID format', async () => {
      const response = await request(app)
        .get('/api/v1/games/not-a-uuid/rsvps');

      expect(response.status).toBe(400);
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
