/**
 * Security tests for authentication and authorization
 */

import { mockPrisma } from '../setup';
import { authenticate, requireRole } from '../../src/api/auth/middleware';
import { PlayerService } from '../../src/services/player-service';
import { Request, Response, NextFunction } from 'express';

// Mock WorkOS verifyToken
const mockVerifyToken = jest.fn();
jest.mock('../../src/services/workos-service', () => ({
  WorkOSService: {
    verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  },
}));

describe('Authentication Security', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = {
      headers: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('authenticate middleware', () => {
    it('should reject requests without authorization header', async () => {
      await authenticate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error).toBeInstanceOf(Error);
      expect(error.statusCode).toBe(401);
    });

    it('should reject requests with empty bearer token', async () => {
      mockReq.headers = { authorization: 'Bearer ' };
      mockVerifyToken.mockResolvedValue(null);
      await authenticate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error).toBeInstanceOf(Error);
      expect(error.statusCode).toBe(401);
    });

    it('should reject requests with non-Bearer auth scheme', async () => {
      mockReq.headers = { authorization: 'Basic dXNlcjpwYXNz' };
      await authenticate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error).toBeInstanceOf(Error);
      expect(error.statusCode).toBe(401);
    });

    it('should reject invalid tokens', async () => {
      mockReq.headers = { authorization: 'Bearer invalid-token' };
      mockVerifyToken.mockResolvedValue(null);
      await authenticate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error).toBeInstanceOf(Error);
      expect(error.statusCode).toBe(401);
    });

    it('should reject tokens for non-existent users', async () => {
      mockReq.headers = { authorization: 'Bearer valid-token' };
      mockVerifyToken.mockResolvedValue({ id: 'workos-user-id' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      await authenticate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error).toBeInstanceOf(Error);
      expect(error.statusCode).toBe(401);
    });
  });

  describe('requireRole middleware', () => {
    it('should reject unauthenticated requests with 401', () => {
      mockReq.user = undefined;
      const middleware = requireRole('ADMIN');
      middleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error.statusCode).toBe(401);
    });

    it('should reject insufficient role with 403 (not 401)', () => {
      mockReq.user = { id: '1', email: 'test@test.com', name: 'Test', role: 'PLAYER' };
      const middleware = requireRole('ADMIN');
      middleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      const error = mockNext.mock.calls[0][0] as unknown as Error & { statusCode?: number };
      expect(error.statusCode).toBe(403);
      expect(error.message).toBe('Insufficient permissions');
    });

    it('should allow authorized role', () => {
      mockReq.user = { id: '1', email: 'test@test.com', name: 'Test', role: 'ADMIN' };
      const middleware = requireRole('ADMIN');
      middleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should allow multiple roles', () => {
      mockReq.user = { id: '1', email: 'test@test.com', name: 'Test', role: 'COACH' };
      const middleware = requireRole('ADMIN', 'COACH');
      middleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledWith();
    });
  });
});

describe('Player Service Authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should prevent non-admin users from updating other players', async () => {
    // Mock the player to update
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'player-id',
        role: 'PLAYER',
        email: 'player@test.com',
        name: 'Player',
      })
      .mockResolvedValueOnce({
        id: 'another-user-id',
        role: 'PLAYER',
        email: 'another@test.com',
        name: 'Another User',
      });

    await expect(
      PlayerService.updatePlayer(
        'player-id',
        { name: 'Hacked Name' },
        'another-user-id'
      )
    ).rejects.toThrow('You can only update your own profile');
  });

  it('should prevent non-admin users from deleting players', async () => {
    // Mock the requesting user as non-admin
    (mockPrisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'regular-user-id',
        role: 'COACH',
        email: 'coach@test.com',
        name: 'Coach',
      })
      .mockResolvedValueOnce({
        id: 'player-id',
        role: 'PLAYER',
        email: 'player@test.com',
        name: 'Player',
        isManaged: false,
        managedById: null,
        teamMembers: [],
        gameEvents: [],
      });

    await expect(
      PlayerService.deletePlayer('player-id', 'regular-user-id')
    ).rejects.toThrow('Only administrators can delete players');
  });
});
