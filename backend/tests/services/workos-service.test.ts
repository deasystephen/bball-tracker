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
        authenticateWithRefreshToken: jest.fn(),
        getUser: jest.fn(),
        listUsers: jest.fn(),
      },
    },
    WORKOS_CLIENT_ID: 'test-client-id',
    WORKOS_REDIRECT_URI: 'http://localhost:3000/auth/callback',
    WORKOS_JWT_ISSUER: 'https://api.workos.com',
    getWorkOSJwks: (): unknown => mockGetWorkOSJwks(),
  };
});

import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, errors as joseErrors, type JWK, type KeyLike } from 'jose';

const mockGetWorkOSJwks = jest.fn();

import { WorkOSService } from '../../src/services/workos-service';
import { mockPrisma } from '../setup';
import { createPlayer } from '../factories';

// Get reference to the mocked module
import { workos } from '../../src/utils/workos-client';
const mockWorkos = {
  userManagement: {
    getAuthorizationUrl: workos.userManagement.getAuthorizationUrl as jest.Mock,
    authenticateWithCode: workos.userManagement.authenticateWithCode as jest.Mock,
    authenticateWithRefreshToken: workos.userManagement.authenticateWithRefreshToken as jest.Mock,
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

  describe('refreshSession', () => {
    it('should exchange a refresh token for a new token pair', async () => {
      const mockResponse = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        user: { id: 'user_123', email: 'test@example.com' },
      };
      mockWorkos.userManagement.authenticateWithRefreshToken.mockResolvedValue(mockResponse);

      const result = await WorkOSService.refreshSession('old-refresh-token');

      expect(result).toEqual(mockResponse);
      expect(mockWorkos.userManagement.authenticateWithRefreshToken).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        refreshToken: 'old-refresh-token',
      });
    });

    it('should propagate WorkOS errors so the route can map them to 401', async () => {
      mockWorkos.userManagement.authenticateWithRefreshToken.mockRejectedValue(new Error('invalid_grant'));
      await expect(WorkOSService.refreshSession('bad')).rejects.toThrow('invalid_grant');
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
    let privateKey: KeyLike;
    let publicJwk: JWK;
    let otherPrivateKey: KeyLike;

    const sign = async (
      claims: Record<string, unknown>,
      opts: { key?: KeyLike; kid?: string; issuer?: string | null; exp?: string | number | null } = {}
    ): Promise<string> => {
      const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'test-key' });
      if (opts.issuer !== null) jwt.setIssuer(opts.issuer ?? 'https://api.workos.com');
      if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? '10m');
      return jwt.setIssuedAt().sign(opts.key ?? privateKey);
    };

    beforeAll(async () => {
      ({ privateKey } = await generateKeyPair('ES256'));
      ({ privateKey: otherPrivateKey } = await generateKeyPair('ES256'));
    });

    beforeEach(async () => {
      // Derive the public JWK from the signing key each time so a test can swap keys.
      const pub = await exportJWK(privateKey);
      delete pub.d;
      publicJwk = { ...pub, kid: 'test-key', alg: 'ES256', use: 'sig' };
      mockGetWorkOSJwks.mockReturnValue(createLocalJWKSet({ keys: [publicJwk] }));
    });

    it('returns the subject for a correctly signed token', async () => {
      const token = await sign({ sub: 'user_123', sid: 'session_abc' });

      const result = await WorkOSService.verifyToken(token);

      expect(result).toMatchObject({ id: 'user_123', sessionId: 'session_abc' });
      expect(typeof result?.expiresAt).toBe('number');
      // Verification is purely local — no WorkOS API round-trip per request.
      expect(mockWorkos.userManagement.getUser).not.toHaveBeenCalled();
    });

    it('rejects an unsigned (alg: none) token that merely names a victim', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'user_victim', iss: 'https://api.workos.com', exp: Math.floor(Date.now() / 1000) + 3600 })
      ).toString('base64url');

      expect(await WorkOSService.verifyToken(`${header}.${payload}.`)).toBeNull();
      expect(await WorkOSService.verifyToken(`${header}.${payload}.x`)).toBeNull();
    });

    it('rejects a token signed with a key that is not in the JWKS', async () => {
      const token = await sign({ sub: 'user_123' }, { key: otherPrivateKey });

      expect(await WorkOSService.verifyToken(token)).toBeNull();
    });

    it('rejects a token whose payload was edited after signing', async () => {
      const token = await sign({ sub: 'user_123' });
      const [h, , sig] = token.split('.');
      const tampered = Buffer.from(
        JSON.stringify({ sub: 'user_admin', iss: 'https://api.workos.com', exp: Math.floor(Date.now() / 1000) + 3600 })
      ).toString('base64url');

      expect(await WorkOSService.verifyToken(`${h}.${tampered}.${sig}`)).toBeNull();
    });

    it('rejects an expired token', async () => {
      const token = await sign({ sub: 'user_123' }, { exp: Math.floor(Date.now() / 1000) - 120 });

      expect(await WorkOSService.verifyToken(token)).toBeNull();
    });

    it('rejects a token with no exp claim', async () => {
      const token = await sign({ sub: 'user_123' }, { exp: null });

      expect(await WorkOSService.verifyToken(token)).toBeNull();
    });

    it('rejects a token with no sub claim', async () => {
      const token = await sign({});

      expect(await WorkOSService.verifyToken(token)).toBeNull();
    });

    it('rejects an HMAC-signed token (algorithm downgrade) without consulting the JWKS', async () => {
      const secret = new TextEncoder().encode('not-the-workos-key');
      const token = await new SignJWT({ sub: 'user_123' })
        .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
        .setIssuer('https://api.workos.com')
        .setExpirationTime('10m')
        .sign(secret);

      expect(await WorkOSService.verifyToken(token)).toBeNull();
      expect(mockGetWorkOSJwks).not.toHaveBeenCalled();
    });

    it('rejects a token from a different issuer', async () => {
      const token = await sign({ sub: 'user_123' }, { issuer: 'https://evil.example.com' });

      expect(await WorkOSService.verifyToken(token)).toBeNull();
    });

    it('returns null for garbage input', async () => {
      expect(await WorkOSService.verifyToken('invalid-token')).toBeNull();
      expect(await WorkOSService.verifyToken('')).toBeNull();
    });

    it('throws ServiceUnavailableError when the JWKS cannot be fetched', async () => {
      mockGetWorkOSJwks.mockReturnValue(async () => {
        throw new joseErrors.JWKSTimeout();
      });
      const token = await sign({ sub: 'user_123' });

      await expect(WorkOSService.verifyToken(token)).rejects.toMatchObject({ statusCode: 503 });
    });

    it('throws ServiceUnavailableError on a network error fetching the JWKS', async () => {
      mockGetWorkOSJwks.mockReturnValue(async () => {
        throw new TypeError('fetch failed');
      });
      const token = await sign({ sub: 'user_123' });

      await expect(WorkOSService.verifyToken(token)).rejects.toMatchObject({ statusCode: 503 });
    });
  });
});
