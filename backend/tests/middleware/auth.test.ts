/**
 * Unit tests for authentication middleware
 */

import { Request, Response, NextFunction } from 'express';
import { authenticate } from '../../src/api/auth/middleware';
import { WorkOSService } from '../../src/services/workos-service';
import { getLogContext, runWithLogContext } from '../../src/utils/log-context';
import { mockPrisma } from '../setup';
import { authUser, devToken } from '../support/auth-fixtures';

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
      const selectedUser = authUser({ email: 'test@example.com', name: 'Test User', role: 'PLAYER' });

      mockReq.headers = {
        authorization: 'Bearer valid-token',
      };

      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(workosUser);
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(selectedUser);

      await authenticate(
        mockReq as Request,
        mockRes as Response,
        nextFn as NextFunction
      );

      expect(mockReq.user).toEqual(selectedUser);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workosUserId: 'workos_123', deletedAt: null } })
      );
      expect(nextFn).toHaveBeenCalledWith();
    });

    describe('log context (#763)', () => {
      // `authenticate` is the only writer of `userId` into the per-request
      // AsyncLocalStorage store that `utils/logger.ts` merges into every line.
      // Each case runs inside a real store, as `requestContext` opens one in
      // production, and reads it before the store closes with the callback.
      const USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
      const dbUser = authUser({ id: USER_ID });

      const originalNodeEnv = process.env.NODE_ENV;
      afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
      });

      async function authenticateInStore(): Promise<ReturnType<typeof getLogContext>> {
        return runWithLogContext({ requestId: 'req-1' }, async () => {
          await authenticate(mockReq as Request, mockRes as Response, nextFn as NextFunction);
          return { ...getLogContext() };
        });
      }

      it('adds userId after a WorkOS token resolves', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        (WorkOSService.verifyToken as jest.Mock).mockResolvedValue({ id: 'workos_123' });
        mockPrisma.user.findUnique.mockResolvedValue(dbUser);

        await expect(authenticateInStore()).resolves.toEqual({ requestId: 'req-1', userId: USER_ID });
        expect(nextFn).toHaveBeenCalledWith();
      });

      it('adds userId after a dev token resolves (development only)', async () => {
        process.env.NODE_ENV = 'development';
        mockReq.headers = {
          authorization: `Bearer ${devToken({ userId: USER_ID })}`,
        };
        mockPrisma.user.findUnique.mockResolvedValue(dbUser);

        await expect(authenticateInStore()).resolves.toEqual({ requestId: 'req-1', userId: USER_ID });
        expect(WorkOSService.verifyToken).not.toHaveBeenCalled();
        expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: USER_ID, deletedAt: null } })
        );
        expect(mockReq.user).toEqual(dbUser);
        expect(nextFn).toHaveBeenCalledWith();
      });

      it('sets no userId when the WorkOS token is refused', async () => {
        mockReq.headers = { authorization: 'Bearer invalid-token' };
        (WorkOSService.verifyToken as jest.Mock).mockResolvedValue(null);

        await expect(authenticateInStore()).resolves.toEqual({ requestId: 'req-1' });
        expect(nextFn).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
      });

      it('sets no userId when a dev token names no live user', async () => {
        process.env.NODE_ENV = 'development';
        mockReq.headers = {
          authorization: `Bearer ${devToken({ userId: USER_ID })}`,
        };
        mockPrisma.user.findUnique.mockResolvedValue(null);

        await expect(authenticateInStore()).resolves.toEqual({ requestId: 'req-1' });
        expect(nextFn).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
      });
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
});
