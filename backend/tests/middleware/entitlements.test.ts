/**
 * Tests for requireFeature and requireUsageLimit middleware
 */

import { Request, Response, NextFunction } from 'express';
import { requireFeature, requireUsageLimit } from '../../src/api/auth/middleware';
import { Feature } from '../../src/utils/entitlements';
import { mockPrisma } from '../setup';
import { createCoach, createAdmin } from '../factories';

describe('Entitlement Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: jest.Mock;

  beforeEach(() => {
    mockReq = { headers: {} };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFn = jest.fn();
    jest.clearAllMocks();
  });

  describe('requireFeature', () => {
    it('should call next with UnauthorizedError if no user', () => {
      const middleware = requireFeature(Feature.STATS_EXPORT);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required', statusCode: 401 })
      );
    });

    it('should return 403 with upgrade_required for FREE user accessing premium feature', () => {
      const coach = createCoach();
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      };

      const middleware = requireFeature(Feature.STATS_EXPORT);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'upgrade_required',
          requiredTier: 'PREMIUM',
        })
      );
      expect(nextFn).not.toHaveBeenCalled();
    });

    it('should call next() for PREMIUM user accessing premium feature', () => {
      const coach = createCoach();
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'PREMIUM',
        subscriptionExpiresAt: future,
      };

      const middleware = requireFeature(Feature.STATS_EXPORT);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should return 403 for expired PREMIUM user', () => {
      const coach = createCoach();
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'PREMIUM',
        subscriptionExpiresAt: new Date('2020-01-01'),
      };

      const middleware = requireFeature(Feature.STATS_EXPORT);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'upgrade_required' })
      );
    });

    it('should bypass entitlement check for ADMIN users', () => {
      const admin = createAdmin();
      mockReq.user = {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'ADMIN',
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      };

      const middleware = requireFeature(Feature.STATS_EXPORT);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should return 403 for PREMIUM user accessing league-only feature', () => {
      const coach = createCoach();
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'PREMIUM',
        subscriptionExpiresAt: future,
      };

      const middleware = requireFeature(Feature.TOURNAMENT_BRACKETS);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'upgrade_required',
          requiredTier: 'LEAGUE',
        })
      );
    });

    it('should call next() for LEAGUE user accessing league feature', () => {
      const coach = createCoach();
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'LEAGUE',
        subscriptionExpiresAt: future,
      };

      const middleware = requireFeature(Feature.TOURNAMENT_BRACKETS);
      middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith();
    });
  });

  describe('requireUsageLimit', () => {
    it('should call next with UnauthorizedError if no user', async () => {
      const middleware = requireUsageLimit('teams');
      await middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required', statusCode: 401 })
      );
    });

    it('should allow FREE user under the team limit', async () => {
      const coach = createCoach();
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      };

      (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(2);

      const middleware = requireUsageLimit('teams');
      await middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should return 403 for FREE user at the team limit', async () => {
      const coach = createCoach();
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      };

      (mockPrisma.teamStaff.count as jest.Mock).mockResolvedValue(3);

      const middleware = requireUsageLimit('teams');
      await middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'usage_limit_reached',
          limit: 3,
          current: 3,
          requiredTier: 'PREMIUM',
        })
      );
    });

    it('should allow PREMIUM user with unlimited teams', async () => {
      const coach = createCoach();
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
        subscriptionTier: 'PREMIUM',
        subscriptionExpiresAt: future,
      };

      const middleware = requireUsageLimit('teams');
      await middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      // Infinity limit means count is never checked
      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should bypass usage limits for ADMIN users', async () => {
      const admin = createAdmin();
      mockReq.user = {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'ADMIN',
        subscriptionTier: 'FREE',
        subscriptionExpiresAt: null,
      };

      const middleware = requireUsageLimit('teams');
      await middleware(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith();
      // Should not even check count
      expect(mockPrisma.teamStaff.count).not.toHaveBeenCalled();
    });
  });
});
