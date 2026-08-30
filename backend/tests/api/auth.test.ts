/**
 * Auth API Integration Tests
 */

import request from 'supertest';
import { ServiceUnavailableError, ConflictError } from '../../src/utils/errors';
import { app, httpServer } from '../../src/index';
import { WorkOSService } from '../../src/services/workos-service';
import prisma from '../../src/models';
import { authRateLimit } from '../../src/api/middleware/rate-limit';

// Mock the WorkOS service
jest.mock('../../src/services/workos-service');

// Mock Prisma
jest.mock('../../src/models', () => ({
  user: {
    findUnique: jest.fn(),
  },
  leagueAdmin: {
    findMany: jest.fn(),
  },
  guardian: {
    findMany: jest.fn().mockResolvedValue([]),
  },
}));

// Spy on Sentry capture while keeping the rest of the util real (index.ts needs
// initSentry / sentryErrorHandler at import time).
jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
}));
import { captureException } from '../../src/utils/sentry';

const mockWorkOSService = WorkOSService as jest.Mocked<typeof WorkOSService>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockCaptureException = captureException as jest.Mock;

describe('Auth API', () => {
  const mockUser = {
    id: 'user-1',
    workosUserId: 'workos-user-1',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    profilePictureUrl: null,
    role: 'PLAYER' as const,
    subscriptionTier: 'FREE' as const,
    subscriptionExpiresAt: null,
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
    // The strict auth limiter (20 req / 15 min / IP) is shared across this
    // file; reset it so the budget is per-test, not per-suite.
    authRateLimit.resetKey('::ffff:127.0.0.1');
    authRateLimit.resetKey('127.0.0.1');
    // Default: the user administers no leagues (decision 3 payload)
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([]);
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

    it('should reject custom redirect_uri with non-allowed host', async () => {
      const response = await request(app)
        .get('/api/v1/auth/login')
        .query({ redirect_uri: 'myapp://callback', format: 'json' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('redirect_uri');
    });

    it('should pass valid custom redirect_uri to WorkOS', async () => {
      mockWorkOSService.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?...'
      );

      await request(app)
        .get('/api/v1/auth/login')
        .query({ redirect_uri: 'http://localhost:3000/callback', format: 'json' });

      expect(mockWorkOSService.getAuthorizationUrl).toHaveBeenCalledWith(
        undefined,
        'http://localhost:3000/callback',
        undefined
      );
    });

    // Audit #5: PKCE + state. The mobile client generates both and we forward
    // them so WorkOS binds the code to the client's verifier.
    describe('PKCE + state', () => {
      const state = 'a'.repeat(32);
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      it('forwards state and code_challenge to WorkOS', async () => {
        mockWorkOSService.getAuthorizationUrl.mockResolvedValue('https://auth.workos.com/authorize?...');

        const response = await request(app)
          .get('/api/v1/auth/login')
          .query({ format: 'json', redirect_uri: 'bball-tracker://auth/callback', state, code_challenge: challenge });

        expect(response.status).toBe(200);
        expect(mockWorkOSService.getAuthorizationUrl).toHaveBeenCalledWith(
          state,
          'bball-tracker://auth/callback',
          challenge
        );
      });

      it('rejects state without code_challenge (and vice versa)', async () => {
        const a = await request(app).get('/api/v1/auth/login').query({ format: 'json', state });
        expect(a.status).toBe(400);
        expect(a.body.error).toMatch(/together/);

        const b = await request(app).get('/api/v1/auth/login').query({ format: 'json', code_challenge: challenge });
        expect(b.status).toBe(400);
        expect(mockWorkOSService.getAuthorizationUrl).not.toHaveBeenCalled();
      });

      it.each([
        ['short challenge', { state, code_challenge: 'too-short' }],
        ['challenge with illegal chars', { state, code_challenge: `${'a'.repeat(42)}+/=` }],
        ['state with illegal chars', { state: 'bad state!' + 'a'.repeat(20), code_challenge: challenge }],
        ['state too short', { state: 'abc', code_challenge: challenge }],
      ])('rejects malformed PKCE/state query: %s', async (_label, query) => {
        const response = await request(app).get('/api/v1/auth/login').query({ format: 'json', ...query });
        expect(response.status).toBe(400);
        expect(mockWorkOSService.getAuthorizationUrl).not.toHaveBeenCalled();
      });
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
      } as unknown as Awaited<ReturnType<typeof mockWorkOSService.exchangeCodeForToken>>);
      mockWorkOSService.syncUser.mockResolvedValue(mockUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.syncUser>>);

      const response = await request(app)
        .get('/api/v1/auth/callback')
        .query({ code: 'auth-code-123' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.accessToken).toBe('mock-access-token');
      // Regression (#349): the client needs the refresh token to survive
      // access-token expiry. Dropping it silently logs every user out after
      // the WorkOS access-token lifetime.
      expect(response.body.refreshToken).toBe('mock-refresh-token');
      // Audit #25: the client needs the avatar to render the profile after login
      expect(response.body.user).toHaveProperty('profilePictureUrl', null);
      // Decision 3: league-admin rows travel with the session user
      expect(response.body.user.leagueAdminOf).toEqual([]);
      // PARENT role: children the user is a guardian of
      expect(response.body.user.guardianOf).toEqual([]);
    });

    it('returns the league ids the user administers as leagueAdminOf (decision 3)', async () => {
      mockWorkOSService.exchangeCodeForToken.mockResolvedValue({
        user: mockWorkOSUser,
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      } as unknown as Awaited<ReturnType<typeof mockWorkOSService.exchangeCodeForToken>>);
      mockWorkOSService.syncUser.mockResolvedValue(mockUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.syncUser>>);
      (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([
        { leagueId: 'downtown-youth-league' },
        { leagueId: 'spring-league' },
      ]);

      const response = await request(app)
        .get('/api/v1/auth/callback')
        .query({ code: 'auth-code-123' });

      expect(response.status).toBe(200);
      expect(response.body.user.leagueAdminOf).toEqual(['downtown-youth-league', 'spring-league']);
      expect(mockPrisma.leagueAdmin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } })
      );
    });

    it('should return 409 (not 500) when the email is bound to another login', async () => {
      mockWorkOSService.exchangeCodeForToken.mockResolvedValue({
        user: mockWorkOSUser,
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      } as unknown as Awaited<ReturnType<typeof mockWorkOSService.exchangeCodeForToken>>);
      mockWorkOSService.syncUser.mockRejectedValue(
        new ConflictError('An account with this email is already linked to a different login')
      );

      const response = await request(app)
        .get('/api/v1/auth/callback')
        .query({ code: 'auth-code-123' });

      expect(response.status).toBe(409);
      expect(response.body.error).toContain('already linked');
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    // Audit #5: the verifier travels with the code so WorkOS can enforce PKCE.
    describe('PKCE + state', () => {
      const state = 'b'.repeat(32);
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

      beforeEach(() => {
        mockWorkOSService.exchangeCodeForToken.mockResolvedValue({
          user: mockWorkOSUser,
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
        } as unknown as Awaited<ReturnType<typeof mockWorkOSService.exchangeCodeForToken>>);
        mockWorkOSService.syncUser.mockResolvedValue(mockUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.syncUser>>);
      });

      it('passes code_verifier to the token exchange', async () => {
        const response = await request(app)
          .get('/api/v1/auth/callback')
          .query({ code: 'auth-code-123', state, code_verifier: verifier });

        expect(response.status).toBe(200);
        expect(mockWorkOSService.exchangeCodeForToken).toHaveBeenCalledWith('auth-code-123', verifier);
      });

      it('exchanges without a verifier when neither state nor code_verifier is sent (legacy clients)', async () => {
        const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code-123' });

        expect(response.status).toBe(200);
        expect(mockWorkOSService.exchangeCodeForToken).toHaveBeenCalledWith('auth-code-123', undefined);
      });

      it('rejects code_verifier without state (and vice versa) before touching WorkOS', async () => {
        const a = await request(app).get('/api/v1/auth/callback').query({ code: 'c', code_verifier: verifier });
        expect(a.status).toBe(400);
        expect(a.body.error).toMatch(/together/);

        const b = await request(app).get('/api/v1/auth/callback').query({ code: 'c', state });
        expect(b.status).toBe(400);
        expect(mockWorkOSService.exchangeCodeForToken).not.toHaveBeenCalled();
      });

      it('rejects a malformed code_verifier', async () => {
        const response = await request(app)
          .get('/api/v1/auth/callback')
          .query({ code: 'c', state, code_verifier: 'nope' });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/code_verifier/);
        expect(mockWorkOSService.exchangeCodeForToken).not.toHaveBeenCalled();
      });

      it('returns 400 (not a session, not a 500) when WorkOS refuses the verifier', async () => {
        // Real SDK shape: OauthException carries a 4xx `status` (audit #42).
        mockWorkOSService.exchangeCodeForToken.mockRejectedValue(
          Object.assign(new Error('Error: invalid_grant\nError Description: code_verifier mismatch'), {
            status: 400,
          })
        );

        const response = await request(app)
          .get('/api/v1/auth/callback')
          .query({ code: 'c', state, code_verifier: verifier });

        expect(response.status).toBe(400);
        expect(response.body.accessToken).toBeUndefined();
        expect(response.body.error).toMatch(/authorization code/i);
      });

      it('still returns 500 when the exchange fails without a definite 4xx (outage)', async () => {
        mockWorkOSService.exchangeCodeForToken.mockRejectedValue(
          Object.assign(new Error('Internal server error'), { status: 500 })
        );

        const response = await request(app)
          .get('/api/v1/auth/callback')
          .query({ code: 'c', state, code_verifier: verifier });

        expect(response.status).toBe(500);
        expect(response.body.accessToken).toBeUndefined();
      });
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
      // Unexpected failures must be reported to Sentry (the prior gap: the
      // callback only logged to CloudWatch, so a DB outage was invisible).
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        flow: 'auth-callback',
      });
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('should exchange a refresh token for a new token pair', async () => {
      mockWorkOSService.refreshSession.mockResolvedValue({
        user: mockWorkOSUser,
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      } as unknown as Awaited<ReturnType<typeof mockWorkOSService.refreshSession>>);

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'old-refresh-token' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });
      expect(mockWorkOSService.refreshSession).toHaveBeenCalledWith('old-refresh-token');
    });

    it('returns 401 for a definite WorkOS rejection (4xx)', async () => {
      mockWorkOSService.refreshSession.mockRejectedValue(Object.assign(new Error('invalid_grant'), { status: 400 }));

      const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'revoked' });

      expect(response.status).toBe(401);
    });

    it('returns 503 (not 401) when WorkOS is down — the client must keep its tokens', async () => {
      mockWorkOSService.refreshSession.mockRejectedValue(Object.assign(new Error('Internal'), { status: 503 }));

      const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'still-valid' });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Authentication service unavailable');
    });

    it('returns 503 on a network failure reaching WorkOS (no status)', async () => {
      mockWorkOSService.refreshSession.mockRejectedValue(new TypeError('fetch failed'));

      const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'still-valid' });

      expect(response.status).toBe(503);
    });

    it('returns 429 with Retry-After when WorkOS rate-limits the refresh', async () => {
      mockWorkOSService.refreshSession.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));

      const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'still-valid' });

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('5');
    });

    it('should return 400 when refreshToken is missing', async () => {
      const response = await request(app).post('/api/v1/auth/refresh').send({});
      expect(response.status).toBe(400);
      expect(mockWorkOSService.refreshSession).not.toHaveBeenCalled();
    });

    it('is not throttled per IP: many devices behind one NAT can each refresh', async () => {
      // The old auth limiter allowed 20 req / 15 min per IP. Every device sends
      // its own refresh token, so 21 distinct tokens from one IP must all pass.
      // (The 429 path is covered in tests/middleware/rate-limit.test.ts — looping
      // 60+ times here would trip the general per-IP API limiter instead.)
      mockWorkOSService.refreshSession.mockResolvedValue({
        user: mockWorkOSUser,
        accessToken: 'a',
        refreshToken: 'r',
      } as unknown as Awaited<ReturnType<typeof mockWorkOSService.refreshSession>>);

      for (let i = 0; i < 21; i++) {
        const response = await request(app)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: `device-${i}-token` });
        expect(response.status).toBe(200);
      }
    });

    it('should return 401 (not 500) when WorkOS rejects the refresh token', async () => {
      mockWorkOSService.refreshSession.mockRejectedValue(Object.assign(new Error('invalid_grant'), { status: 400 }));

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'revoked' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid or expired refresh token');
      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return current user information', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.id).toBe('user-1');
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.user.leagueAdminOf).toEqual([]);
      expect(response.body.user.guardianOf).toEqual([]);
    });

    it('includes leagueAdminOf with the league ids the user administers (decision 3)', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([{ leagueId: 'spring-league' }]);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        role: 'PLAYER',
        profilePictureUrl: null,
        leagueAdminOf: ['spring-league'],
      });
      expect(response.body.user).toHaveProperty('createdAt');
    });

    it('returns guardianOf with the caller\'s children (PARENT role)', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...mockUser, role: 'PARENT' });
      (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValueOnce([
        { childId: 'child-1', relationship: 'MOTHER', isPrimary: true, child: { name: 'Kid One', teamMembers: [] } },
      ]);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.user.guardianOf).toEqual([
        { childId: 'child-1', childName: 'Kid One', relationship: 'MOTHER', isPrimary: true, teams: [] },
      ]);
      expect(mockPrisma.guardian.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentId: 'user-1' } })
      );
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

    it('should return 503 (not 500, not 401) when token verification is unavailable', async () => {
      mockWorkOSService.verifyToken.mockRejectedValue(new ServiceUnavailableError('Authentication service unavailable'));

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Authentication service unavailable');
      expect(mockCaptureException).not.toHaveBeenCalled();
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
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
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
      // Auth now runs in the shared `authenticate` middleware, so an
      // unexpected verifyToken error reaches the central error handler.
      expect(response.body.error).toBe('Internal server error');
    });
  });

  describe('GET /api/v1/auth/entitlements', () => {
    it('should return FREE tier entitlements for free user', async () => {
      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const response = await request(app)
        .get('/api/v1/auth/entitlements')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.tier).toBe('FREE');
      expect(response.body.features.STATS_EXPORT).toBe(false);
      expect(response.body.features.AD_FREE).toBe(false);
      expect(response.body.limits.maxTeams).toBe(3);
      // Seasons are metered, never capped (audit #81): Infinity serializes as null.
      expect(response.body.limits.maxSeasons).toBeNull();
      expect(response.body.expiresAt).toBeNull();
    });

    it('should return PREMIUM tier entitlements for active premium user', async () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const premiumUser = {
        ...mockUser,
        subscriptionTier: 'PREMIUM' as const,
        subscriptionExpiresAt: future,
      };

      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(premiumUser);

      const response = await request(app)
        .get('/api/v1/auth/entitlements')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.tier).toBe('PREMIUM');
      expect(response.body.features.STATS_EXPORT).toBe(true);
      expect(response.body.features.AD_FREE).toBe(true);
      expect(response.body.features.TOURNAMENT_BRACKETS).toBe(false);
      expect(response.body.limits.maxTeams).toBe(null); // Infinity serializes to null in JSON
    });

    it('should return FREE tier for expired premium user', async () => {
      const expiredUser = {
        ...mockUser,
        subscriptionTier: 'PREMIUM' as const,
        subscriptionExpiresAt: new Date('2020-01-01'),
      };

      mockWorkOSService.verifyToken.mockResolvedValue(mockWorkOSUser as unknown as Awaited<ReturnType<typeof mockWorkOSService.verifyToken>>);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(expiredUser);

      const response = await request(app)
        .get('/api/v1/auth/entitlements')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.tier).toBe('FREE');
      expect(response.body.features.STATS_EXPORT).toBe(false);
      expect(response.body.limits.maxTeams).toBe(3);
    });

    it('should return 401 without authorization', async () => {
      const response = await request(app)
        .get('/api/v1/auth/entitlements');

      expect(response.status).toBe(401);
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
