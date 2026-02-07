/**
 * Unit tests for authentication middleware
 */

import { Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../../src/api/auth/middleware';
import { WorkOSService } from '../../src/services/workos-service';
import { mockPrisma } from '../setup';
import { createPlayer, createCoach, createAdmin } from '../factories';

// Mock WorkOSService
jest.mock('../../src/services/workos-service');

describe('Auth Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: jest.Mock;

  beforeEach(() => {
    mockReq = {
      headers: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFn = jest.fn();
    jest.clearAllMocks();
  });

  describe('authenticate', () => {
    it('should call next() with error if no authorization header', async () => {
      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Authorization token required',
          statusCode: 401,
        })
      );
    });

    it('should call next() with error if authorization header does not start with Bearer', async () => {
      mockReq.headers = {
        authorization: 'Basic some-token',
      };

      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Authorization token required',
          statusCode: 401,
        })
      );
    });

    it('should call next() with error if token is invalid', async () => {
      mockReq.headers = {
        authorization: 'Bearer invalid-token',
      };

      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(null);

      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid or expired token',
          statusCode: 401,
        })
      );
    });

    it('should call next() with error if user not found in database', async () => {
      const workosUser = { id: 'workos_123', email: 'test@example.com' };
      mockReq.headers = {
        authorization: 'Bearer valid-token',
      };

      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(workosUser);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'User not found',
          statusCode: 401,
        })
      );
    });

    it('should attach user to request and call next() on success', async () => {
      const workosUser = { id: 'workos_123', email: 'test@example.com' };
      const dbUser = createPlayer({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
        workosUserId: 'workos_123',
      });

      mockReq.headers = {
        authorization: 'Bearer valid-token',
      };

      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(workosUser);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
      });

      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(mockReq.user).toEqual({
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
      });
      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should handle WorkOS verification errors gracefully', async () => {
      mockReq.headers = {
        authorization: 'Bearer some-token',
      };

      (WorkOSService.verifyToken as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('requireRole', () => {
    it('should call next() with error if user is not authenticated', () => {
      const middleware = requireRole('COACH');

      middleware(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Authentication required',
          statusCode: 401,
        })
      );
    });

    it('should call next() with error if user does not have required role', () => {
      const player = createPlayer();
      mockReq.user = {
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
      };

      const middleware = requireRole('COACH');

      middleware(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Insufficient permissions',
          statusCode: 403,
        })
      );
    });

    it('should call next() if user has required role', () => {
      const coach = createCoach();
      mockReq.user = {
        id: coach.id,
        email: coach.email,
        name: coach.name,
        role: 'COACH',
      };

      const middleware = requireRole('COACH');

      middleware(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should allow multiple roles', () => {
      const player = createPlayer();
      mockReq.user = {
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
      };

      const middleware = requireRole('COACH', 'PLAYER', 'ADMIN');

      middleware(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith();
    });

    it('should work with ADMIN role', () => {
      const admin = createAdmin();
      mockReq.user = {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'ADMIN',
      };

      const middleware = requireRole('ADMIN');

      middleware(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(nextFn).toHaveBeenCalledWith();
    });
  });
});
