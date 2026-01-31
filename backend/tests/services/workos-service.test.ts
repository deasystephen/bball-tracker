/**
 * Unit tests for WorkOSService
 */

// Mock workos client - must declare mock functions separately to avoid hoisting issues
jest.mock('../../src/utils/workos-client', () => {
  return {
    workos: {
      userManagement: {
        getAuthorizationUrl: jest.fn(),
        authenticateWithCode: jest.fn(),
        getUser: jest.fn(),
        listUsers: jest.fn(),
      },
    },
    WORKOS_CLIENT_ID: 'test-client-id',
    WORKOS_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  };
});

import { WorkOSService } from '../../src/services/workos-service';
import { mockPrisma } from '../setup';
import { createPlayer } from '../factories';

// Get reference to the mocked module
import { workos } from '../../src/utils/workos-client';
const mockWorkos = {
  userManagement: {
    getAuthorizationUrl: workos.userManagement.getAuthorizationUrl as jest.Mock,
    authenticateWithCode: workos.userManagement.authenticateWithCode as jest.Mock,
    getUser: workos.userManagement.getUser as jest.Mock,
    listUsers: workos.userManagement.listUsers as jest.Mock,
  },
};

describe('WorkOSService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.WORKOS_CONNECTION_ID;
    delete process.env.WORKOS_ORGANIZATION_ID;
    delete process.env.WORKOS_PROVIDER;
  });

  describe('getAuthorizationUrl', () => {
    it('should return authorization URL with authkit provider by default', async () => {
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?provider=authkit'
      );

      const result = await WorkOSService.getAuthorizationUrl();

      expect(result).toBe('https://auth.workos.com/authorize?provider=authkit');
      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'test-client-id',
          redirectUri: 'http://localhost:3000/auth/callback',
          provider: 'authkit',
        })
      );
    });

    it('should include state parameter if provided', async () => {
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?state=test-state'
      );

      const result = await WorkOSService.getAuthorizationUrl('test-state');

      expect(result).toContain('state=test-state');
      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'test-state',
        })
      );
    });

    it('should use custom redirect URI if provided', async () => {
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl(undefined, 'myapp://callback');

      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUri: 'myapp://callback',
        })
      );
    });

    it('should use connection ID if provided in environment', async () => {
      process.env.WORKOS_CONNECTION_ID = 'conn_123';
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl();

      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn_123',
        })
      );
    });

    it('should use organization ID if connection ID not provided', async () => {
      process.env.WORKOS_ORGANIZATION_ID = 'org_123';
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl();

      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org_123',
        })
      );
    });

    it('should use provider from environment if set', async () => {
      process.env.WORKOS_PROVIDER = 'GoogleOAuth';
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl();

      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'GoogleOAuth',
        })
      );
    });
  });

  describe('exchangeCodeForToken', () => {
    it('should exchange code for token', async () => {
      const mockResponse = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'user_123',
          email: 'test@example.com',
        },
      };
      mockWorkos.userManagement.authenticateWithCode.mockResolvedValue(mockResponse);

      const result = await WorkOSService.exchangeCodeForToken('auth-code');

      expect(result).toEqual(mockResponse);
      expect(mockWorkos.userManagement.authenticateWithCode).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        code: 'auth-code',
      });
    });
  });

  describe('getUser', () => {
    it('should get user from WorkOS', async () => {
      const mockUser = {
        id: 'user_123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      };
      mockWorkos.userManagement.getUser.mockResolvedValue(mockUser);

      const result = await WorkOSService.getUser('user_123');

      expect(result).toEqual(mockUser);
      expect(mockWorkos.userManagement.getUser).toHaveBeenCalledWith('user_123');
    });
  });

  describe('listUsers', () => {
    it('should list users from WorkOS', async () => {
      const mockUsers = {
        data: [
          { id: 'user_1', email: 'user1@example.com' },
          { id: 'user_2', email: 'user2@example.com' },
        ],
        listMetadata: {
          after: null,
          before: null,
        },
      };
      mockWorkos.userManagement.listUsers.mockResolvedValue(mockUsers);

      const result = await WorkOSService.listUsers();

      expect(result).toEqual(mockUsers);
      expect(mockWorkos.userManagement.listUsers).toHaveBeenCalled();
    });

    it('should pass options to list users', async () => {
      const mockUsers = {
        data: [{ id: 'user_1', email: 'specific@example.com' }],
        listMetadata: { after: null, before: null },
      };
      mockWorkos.userManagement.listUsers.mockResolvedValue(mockUsers);

      await WorkOSService.listUsers({ email: 'specific@example.com', limit: 10 });

      expect(mockWorkos.userManagement.listUsers).toHaveBeenCalledWith({
        email: 'specific@example.com',
        limit: 10,
      });
    });
  });

  describe('syncUser', () => {
    it('should create new user if not exists', async () => {
      const workosUser = {
        id: 'workos_123',
        email: 'newuser@example.com',
        firstName: 'New',
        lastName: 'User',
        emailVerified: true,
        profilePictureUrl: 'https://example.com/avatar.jpg',
      };
      const player = createPlayer({
        email: 'newuser@example.com',
        name: 'New User',
        workosUserId: 'workos_123',
      });

      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(player);

      const result = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('id', player.id);
      expect(result).toHaveProperty('email', 'newuser@example.com');
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workosUserId: 'workos_123',
            email: 'newuser@example.com',
            name: 'New User',
            role: 'PLAYER',
          }),
        })
      );
    });

    it('should update existing user by WorkOS ID', async () => {
      const existingUser = createPlayer({
        email: 'existing@example.com',
        name: 'Existing User',
        workosUserId: 'workos_123',
      });
      const workosUser = {
        id: 'workos_123',
        email: 'updated@example.com',
        firstName: 'Updated',
        lastName: 'Name',
        emailVerified: true,
      };

      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(existingUser);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...existingUser,
        email: 'updated@example.com',
        name: 'Updated Name',
      });

      const result = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('email', 'updated@example.com');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existingUser.id },
          data: expect.objectContaining({
            workosUserId: 'workos_123',
            email: 'updated@example.com',
            name: 'Updated Name',
          }),
        })
      );
    });

    it('should update existing user by email', async () => {
      const existingUser = createPlayer({
        email: 'user@example.com',
        name: 'Old Name',
        workosUserId: null,
      });
      const workosUser = {
        id: 'workos_456',
        email: 'user@example.com',
        firstName: 'New',
        lastName: 'Name',
        emailVerified: true,
      };

      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(existingUser);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...existingUser,
        workosUserId: 'workos_456',
        name: 'New Name',
      });

      const result = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('workosUserId', 'workos_456');
      expect(result).toHaveProperty('name', 'New Name');
    });

    it('should use email prefix as name if no first/last name provided', async () => {
      const workosUser = {
        id: 'workos_789',
        email: 'johndoe@example.com',
        emailVerified: false,
      };
      const player = createPlayer({
        email: 'johndoe@example.com',
        name: 'johndoe',
      });

      (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(player);

      await WorkOSService.syncUser(workosUser);

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'johndoe',
          }),
        })
      );
    });
  });

  describe('verifyToken', () => {
    it('should verify valid token and return user', async () => {
      // Create a valid JWT payload
      const payload = {
        sub: 'user_123',
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      };
      const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const mockToken = `header.${base64Payload}.signature`;

      const mockUser = {
        id: 'user_123',
        email: 'test@example.com',
      };
      mockWorkos.userManagement.getUser.mockResolvedValue(mockUser);

      const result = await WorkOSService.verifyToken(mockToken);

      expect(result).toEqual(mockUser);
      expect(mockWorkos.userManagement.getUser).toHaveBeenCalledWith('user_123');
    });

    it('should return null for invalid token format', async () => {
      const result = await WorkOSService.verifyToken('invalid-token');

      expect(result).toBeNull();
    });

    it('should return null for token without user ID', async () => {
      const payload = { exp: Math.floor(Date.now() / 1000) + 3600 };
      const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const mockToken = `header.${base64Payload}.signature`;

      const result = await WorkOSService.verifyToken(mockToken);

      expect(result).toBeNull();
    });

    it('should return null if WorkOS getUser fails', async () => {
      const payload = {
        sub: 'user_123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const mockToken = `header.${base64Payload}.signature`;

      mockWorkos.userManagement.getUser.mockRejectedValue(new Error('User not found'));

      const result = await WorkOSService.verifyToken(mockToken);

      expect(result).toBeNull();
    });
  });
});
