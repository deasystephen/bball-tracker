/**
 * Unit tests for authentication middleware
 */

import { Request, Response, NextFunction } from 'express';
import { AGE_GATE_EXEMPT, assertAgeConfirmed, authenticate, isAgeConfirmed } from '../../src/api/auth/middleware';
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

  describe('the age gate (#981)', () => {
    const originalFlag = process.env.AGE_GATE_ENFORCED;
    const unconfirmed = { ageConfirmedAt: null, ageRefusedAt: null };
    const confirmed = { ageConfirmedAt: new Date(), ageRefusedAt: null };
    const refused = { ageConfirmedAt: null, ageRefusedAt: new Date() };

    const requestFor = (method: string, baseUrl: string, path: string): Request =>
      ({ method, baseUrl, path } as unknown as Request);

    beforeEach(() => {
      delete process.env.AGE_GATE_ENFORCED;
    });

    afterAll(() => {
      if (originalFlag === undefined) delete process.env.AGE_GATE_ENFORCED;
      else process.env.AGE_GATE_ENFORCED = originalFlag;
    });

    it('refuses an unconfirmed account on a protected route with 403 age_confirmation_required', () => {
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/teams', '/'), unconfirmed)).toThrow(
        expect.objectContaining({ statusCode: 403, code: 'age_confirmation_required' })
      );
      expect(() => assertAgeConfirmed(requestFor('PATCH', '/api/v1/auth', '/me'), unconfirmed)).toThrow(
        expect.objectContaining({ code: 'age_confirmation_required' })
      );
    });

    it('lets the exempt routes through, with or without a trailing slash', () => {
      for (const key of AGE_GATE_EXEMPT) {
        const [method, path] = key.split(' ');
        const tail = path.replace('/auth', '');
        expect(() => assertAgeConfirmed(requestFor(method, '/api/v1/auth', tail), unconfirmed)).not.toThrow();
        expect(() => assertAgeConfirmed(requestFor(method, '/api/v1/auth', `${tail}/`), unconfirmed)).not.toThrow();
      }
    });

    it('matches on the method too: a GET on the confirmation route is not exempt', () => {
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/auth', '/age-confirmation'), unconfirmed)).toThrow();
      expect(() => assertAgeConfirmed(requestFor('PATCH', '/api/v1/auth', '/me'), unconfirmed)).toThrow();
    });

    it('never refuses a confirmed account', () => {
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/teams', '/'), confirmed)).not.toThrow();
    });

    it('a refused account (awaiting the operator) is never allowed, exempt routes aside, even with the flag off', () => {
      expect(isAgeConfirmed(refused)).toBe(false);
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/teams', '/'), refused)).toThrow();
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/auth', '/me'), refused)).not.toThrow();
      process.env.AGE_GATE_ENFORCED = 'false';
      expect(isAgeConfirmed(refused)).toBe(false);
      expect(isAgeConfirmed(unconfirmed)).toBe(true);
      expect(isAgeConfirmed(confirmed)).toBe(true);
    });

    it('is relaxed only by AGE_GATE_ENFORCED=false', () => {
      process.env.AGE_GATE_ENFORCED = 'false';
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/teams', '/'), unconfirmed)).not.toThrow();
      process.env.AGE_GATE_ENFORCED = 'off';
      expect(() => assertAgeConfirmed(requestFor('GET', '/api/v1/teams', '/'), unconfirmed)).toThrow();
    });

    it('authenticate answers the gate\'s 403 through next(), not as a 401', async () => {
      mockReq.headers = { authorization: 'Bearer valid-token' };
      (mockReq as { method?: string; baseUrl?: string; path?: string }).method = 'GET';
      (mockReq as { baseUrl?: string }).baseUrl = '/api/v1/teams';
      (mockReq as { path?: string }).path = '/';
      (WorkOSService.verifyToken as jest.Mock).mockResolvedValue({ id: 'workos-1', expiresAt: 0 });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(authUser({ ageConfirmedAt: null }));

      await authenticate(mockReq as Request, mockRes as Response, nextFn as NextFunction);

      expect(nextFn).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'age_confirmation_required' }));
      expect(mockReq.user).toMatchObject({ id: authUser().id, ageConfirmedAt: null });
    });
  });
});
