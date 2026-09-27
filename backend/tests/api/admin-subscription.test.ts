/**
 * API tests for PATCH /api/v1/admin/users/:userId/subscription (#445).
 *
 * The service is NOT mocked: every request runs validation -> route ->
 * SubscriptionService -> (mocked) Prisma, the same path as production.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';

const ADMIN_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TARGET_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

let currentRole = 'ADMIN';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: ADMIN_ID,
      email: 'admin@example.com',
      name: 'Admin',
      role: currentRole,
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

jest.mock('../../src/utils/redis', () => ({
  ...jest.requireActual('../../src/utils/redis'),
  cacheGetJson: jest.fn(),
  cacheSetJson: jest.fn(),
  cacheDelete: jest.fn(),
}));

import { cacheDelete } from '../../src/utils/redis';

const mockCacheDelete = cacheDelete as jest.Mock;

const url = (userId: string = TARGET_ID): string => `/api/v1/admin/users/${userId}/subscription`;

/** A live FREE account, and a write that stores whatever the request sent. */
function mockLiveTarget(): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
    deletedAt: null,
  });
  let written: { subscriptionTier: string; subscriptionExpiresAt: Date | null } = {
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
  };
  (mockPrisma.user.updateMany as jest.Mock).mockImplementation(
    async ({ data }: { data: typeof written }) => {
      written = data;
      return { count: 1 };
    }
  );
  (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockImplementation(async () => ({
    id: TARGET_ID,
    name: 'Casey Coach',
    email: 'casey@example.com',
    role: 'COACH',
    ...written,
  }));
}

describe('PATCH /api/v1/admin/users/:userId/subscription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentRole = 'ADMIN';
    mockLiveTarget();
  });

  describe('as a system ADMIN', () => {
    it('comps an account to PREMIUM until the expiry', async () => {
      const res = await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        user: {
          id: TARGET_ID,
          name: 'Casey Coach',
          email: 'casey@example.com',
          role: 'COACH',
          subscriptionTier: 'PREMIUM',
          subscriptionExpiresAt: FUTURE,
        },
        effectiveTier: 'PREMIUM',
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: TARGET_ID, deletedAt: null },
        data: { subscriptionTier: 'PREMIUM', subscriptionExpiresAt: new Date(FUTURE) },
      });
    });

    it('comps an account to LEAGUE', async () => {
      const res = await request(app).patch(url()).send({ tier: 'LEAGUE', expiresAt: FUTURE });

      expect(res.status).toBe(200);
      expect(res.body.user.subscriptionTier).toBe('LEAGUE');
      expect(res.body.effectiveTier).toBe('LEAGUE');
    });

    it('returns an account to FREE with no expiry', async () => {
      const res = await request(app).patch(url()).send({ tier: 'FREE' });

      expect(res.status).toBe(200);
      expect(res.body.user.subscriptionTier).toBe('FREE');
      expect(res.body.user.subscriptionExpiresAt).toBeNull();
      expect(res.body.effectiveTier).toBe('FREE');
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: TARGET_ID, deletedAt: null },
        data: { subscriptionTier: 'FREE', subscriptionExpiresAt: null },
      });
    });

    it("invalidates the target's cached usage", async () => {
      await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(mockCacheDelete).toHaveBeenCalledWith(`usage:counts:${TARGET_ID}`);
    });

    it('never returns internal columns', async () => {
      const res = await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(Object.keys(res.body.user).sort()).toEqual(
        ['email', 'id', 'name', 'role', 'subscriptionExpiresAt', 'subscriptionTier'].sort()
      );
    });
  });

  describe('authorization', () => {
    it.each(['COACH', 'PLAYER', 'PARENT'])('answers 403 for a %s', async (role) => {
      currentRole = role;

      const res = await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Only system admins can change a subscription' });
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('does not let a coach upgrade their own account', async () => {
      currentRole = 'COACH';

      const res = await request(app).patch(url(ADMIN_ID)).send({ tier: 'LEAGUE', expiresAt: FUTURE });

      expect(res.status).toBe(403);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('target account', () => {
    it('answers 404 for an unknown user', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'User not found' });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a deleted account with 400 and writes nothing', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
        deletedAt: new Date('2026-09-01'),
      });

      const res = await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Cannot change the subscription of a deleted account' });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
      expect(mockCacheDelete).not.toHaveBeenCalled();
    });

    it('refuses with 400 when the account is deleted underneath the request', async () => {
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const res = await request(app).patch(url()).send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(res.status).toBe(400);
      expect(mockPrisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('answers 400 for a userId that is not a UUID', async () => {
      const res = await request(app)
        .patch(url('not-a-uuid'))
        .send({ tier: 'PREMIUM', expiresAt: FUTURE });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid userId format' });
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('invalid body (400)', () => {
    it.each([
      ['an unknown tier', { tier: 'GOLD', expiresAt: FUTURE }],
      ['a lowercase tier', { tier: 'premium', expiresAt: FUTURE }],
      ['a missing tier', { expiresAt: FUTURE }],
      ['an empty body', {}],
      ['a paid tier without an expiry', { tier: 'PREMIUM' }],
      ['a paid tier with a null expiry', { tier: 'LEAGUE', expiresAt: null }],
      ['an expiry in the past', { tier: 'PREMIUM', expiresAt: '2020-01-01T00:00:00.000Z' }],
      ['an expiry that is not a date-time', { tier: 'PREMIUM', expiresAt: 'next month' }],
      ['FREE with an expiry', { tier: 'FREE', expiresAt: FUTURE }],
    ])('rejects %s', async (_label, body) => {
      const res = await request(app).patch(url()).send(body);

      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('explains why a paid tier needs an expiry', async () => {
      const res = await request(app).patch(url()).send({ tier: 'PREMIUM' });

      expect(res.body.error).toBe(
        'expiresAt is required for PREMIUM: a paid tier without an expiry resolves to FREE'
      );
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
