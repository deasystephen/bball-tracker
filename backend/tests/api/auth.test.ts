/**
 * Auth API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { WorkOSService } from '../../src/services/workos-service';
import prisma from '../../src/models';

// Mock the WorkOS service
jest.mock('../../src/services/workos-service');

// Mock Prisma
jest.mock('../../src/models', () => ({
  user: {
    findUnique: jest.fn(),
  },
}));

const mockWorkOSService = WorkOSService as jest.Mocked<typeof WorkOSService>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe('Auth API', () => {
  const mockUser = {
    id: 'user-1',
    workosUserId: 'workos-user-1',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    profilePictureUrl: null,
    role: 'PLAYER' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockWorkOSUser = {
    id: 'workos-user-1',
    object: 'user' as const,
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    emailVerified: true,
    profilePictureUrl: null,
    lastSignInAt: null,
    locale: 'en',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    externalId: null,
    metadata: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/auth/login', () => {
    it('should redirect to WorkOS authorization URL for web browsers', async () => {
      mockWorkOSService.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?...'
      );

      const response = await request(app)
        .get('/api/v1/auth/login')
        .set('Accept', 'text/html');

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('auth.workos.com');
    });

    it('should return JSON with authorization URL for mobile apps', async () => {
      mockWorkOSService.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?...'
      );

      const response = await request(app)
        .get('/api/v1/auth/login')
        .query({ format: 'json' });

      expect(response.status).toBe(200);
      expect(response.body.url).toContain('auth.workos.com');
    });

    it('should return JSON with Accept header', async () => {
      mockWorkOSService.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?...'
      );

      const response = await request(app)
        .get('/api/v1/auth/login')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.url).toBeDefined();
    });

    it('should pass custom redirect_uri to WorkOS', async () => {
      mockWorkOSService.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?...'
      );

      await request(app)
        .get('/api/v1/auth/login')
        .query({ redirect_uri: 'myapp://callback', format: 'json' });

      expect(mockWorkOSService.getAuthorizationUrl).toHaveBeenCalledWith(
        undefined,
        'myapp://callback'
      );
    });

    it('should handle WorkOS service errors', async () => {
      mockWorkOSService.getAuthorizationUrl.mockRejectedValue(
        new Error('WorkOS configuration error')
      );

      const response = await request(app)
        .get('/api/v1/auth/login')
        .query({ format: 'json' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to generate authorization URL');
    });
  });

  describe('GET /api/v1/auth/callback', () => {
    it('should exchange code for token and return user', async () => {
      mockWorkOSService.exchangeCodeForToken.mockResolvedValue({
        user: mockWorkOSUser,
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      } as any);
      mockWorkOSService.syncUser.mockResolvedValue(mockUser as any);

      const response = await request(app)
        .get('/api/v1/auth/callback')
        .query({ code: 'auth-code-123' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.accessToken).toBe('mock-access-token');
    });

    it('should return 400 for missing code', async () => {
      const response = await request(app).get('/api/v1/auth/callback');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Authorization code is required');
    });

    it('should return 400 for authentication error', async () => {
      const response = await request(app)
        .get('/api/v1/auth/callback')
        .query({ error: 'access_denied' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('access_denied');
    });

    it('should handle token exchange errors', async () => {
      mockWorkOSService.exchangeCodeForToken.mockRejectedValue(
        new Error('Invalid code')
      );

      const response = await request(app)
        .get('/api/v1/auth/callback')
        .query({ code: 'invalid-code' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Authentication failed');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return current user information', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as any);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.id).toBe('user-1');
      expect(response.body.user.email).toBe('test@example.com');
    });

    it('should return 401 for missing authorization header', async () => {
      const response = await request(app).get('/api/v1/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Authorization token required');
    });

    it('should return 401 for invalid authorization format', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'InvalidFormat token');

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Authorization token required');
    });

    it('should return 401 for invalid token', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Invalid or expired token');
    });

    it('should return 401 for user not found in database', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as any);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('User not found');
    });

    it('should handle token verification errors', async () => {
      mockWorkOSService.verifyToken.mockRejectedValue(
        new Error('Token verification failed')
      );

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to get user information');
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
