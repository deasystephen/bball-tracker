/**
 * Push Token API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { NotificationService } from '../../src/services/notification-service';
import { BadRequestError, ConflictError, ServiceUnavailableError, UnauthorizedError } from '../../src/utils/errors';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';

// Mock auth middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: TEST_USER_ID,
      email: 'test@example.com',
      name: 'Test User',
      role: 'PLAYER',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

jest.mock('../../src/services/notification-service');

const mockNotificationService = NotificationService as jest.Mocked<typeof NotificationService>;

describe('Push Token API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/auth/push-token', () => {
    it('should register a push token successfully', async () => {
      mockNotificationService.registerToken.mockResolvedValue({
        id: 'token-id',
        userId: TEST_USER_ID,
        token: 'ExponentPushToken[abc123]',
        platform: 'ios',
        createdAt: new Date(),
      } as unknown as Awaited<ReturnType<typeof mockNotificationService.registerToken>>);

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]', platform: 'ios' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.pushToken).toBeDefined();
      expect(mockNotificationService.registerToken).toHaveBeenCalledWith(
        TEST_USER_ID,
        'ExponentPushToken[abc123]',
        'ios'
      );
    });

    it('should return 400 for missing token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ platform: 'ios' });

      expect(response.status).toBe(400);
    });

    it('returns 400 Token is required when there is no body at all', async () => {
      const response = await request(app).post('/api/v1/auth/push-token');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Token is required');
      expect(mockNotificationService.registerToken).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid platform', async () => {
      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]', platform: 'windows' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid Expo push token', async () => {
      mockNotificationService.registerToken.mockRejectedValue(
        new BadRequestError('Invalid Expo push token')
      );

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'invalid-token', platform: 'ios' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid Expo push token');
    });

    it('returns 409 when the token is freshly bound to another account (role matrix B2.9)', async () => {
      mockNotificationService.registerToken.mockRejectedValue(
        new ConflictError('Push token is registered to another account')
      );

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[someone-elses]', platform: 'ios' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Push token is registered to another account');
    });

    it('returns 401 when the caller was deleted between authenticate and the write (#761)', async () => {
      mockNotificationService.registerToken.mockRejectedValue(new UnauthorizedError('User not found'));

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]', platform: 'ios' });

      expect(response.status).toBe(401);
      // Same body the authenticate middleware answers for a deleted account
      expect(response.body).toEqual({ error: 'User not found' });
    });

    it('still answers 500 for an unexpected failure', async () => {
      mockNotificationService.registerToken.mockRejectedValue(new Error('connection reset'));

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]', platform: 'ios' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to register push token' });
    });

    it('keeps the status of a 5xx AppError but answers the generic body', async () => {
      mockNotificationService.registerToken.mockRejectedValue(new ServiceUnavailableError('Database unavailable'));

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]', platform: 'ios' });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Failed to register push token' });
    });
  });

  describe('DELETE /api/v1/auth/push-token', () => {
    it('should remove a push token successfully', async () => {
      mockNotificationService.removeToken.mockResolvedValue({ count: 1 } as unknown as Awaited<ReturnType<typeof mockNotificationService.removeToken>>);

      const response = await request(app)
        .delete('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Scoped to the caller so nobody can unregister another user's device (audit #47)
      expect(mockNotificationService.removeToken).toHaveBeenCalledWith(
        TEST_USER_ID,
        'ExponentPushToken[abc123]'
      );
    });

    it('returns 200 (no-op) when the token belongs to another user', async () => {
      mockNotificationService.removeToken.mockResolvedValue({ count: 0 } as unknown as Awaited<ReturnType<typeof mockNotificationService.removeToken>>);

      const response = await request(app)
        .delete('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[someone-else]' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 for missing token', async () => {
      const response = await request(app)
        .delete('/api/v1/auth/push-token')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Token is required');
      expect(mockNotificationService.removeToken).not.toHaveBeenCalled();
    });

    it('returns 400 Token is required when there is no body at all', async () => {
      const response = await request(app).delete('/api/v1/auth/push-token');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Token is required');
      expect(mockNotificationService.removeToken).not.toHaveBeenCalled();
    });

    // An object token used to reach Prisma as a filter and delete every
    // token the caller owns; a number used to throw inside Prisma (500) (#649).
    it.each([
      ['an empty object', {}],
      ['a contains filter', { contains: '' }],
      ['a not filter', { not: '' }],
      ['a number', 123],
      ['an array', ['ExponentPushToken[abc123]']],
      ['a boolean', true],
      ['null', null],
    ])('returns 400 and removes nothing for %s as token', async (_label, token) => {
      const response = await request(app)
        .delete('/api/v1/auth/push-token')
        .send({ token });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Token must be a string');
      expect(mockNotificationService.removeToken).not.toHaveBeenCalled();
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
