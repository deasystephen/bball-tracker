/**
 * Push Token API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { NotificationService } from '../../src/services/notification-service';

const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';

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
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
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
      } as any);

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

    it('should return 400 for invalid platform', async () => {
      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]', platform: 'windows' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid Expo push token', async () => {
      mockNotificationService.registerToken.mockRejectedValue(
        new Error('Invalid Expo push token')
      );

      const response = await request(app)
        .post('/api/v1/auth/push-token')
        .send({ token: 'invalid-token', platform: 'ios' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid Expo push token');
    });
  });

  describe('DELETE /api/v1/auth/push-token', () => {
    it('should remove a push token successfully', async () => {
      mockNotificationService.removeToken.mockResolvedValue({ count: 1 } as any);

      const response = await request(app)
        .delete('/api/v1/auth/push-token')
        .send({ token: 'ExponentPushToken[abc123]' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 for missing token', async () => {
      const response = await request(app)
        .delete('/api/v1/auth/push-token')
        .send({});

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
