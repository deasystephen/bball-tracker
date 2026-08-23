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
        revokeSession: jest.fn(),
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

import { Prisma } from '@prisma/client';
import { WorkOSService } from '../../src/services/workos-service';
import { ConflictError } from '../../src/utils/errors';
import { mockPrisma } from '../setup';
import { createPlayer } from '../factories';

// Get reference to the mocked module
import { workos } from '../../src/utils/workos-client';
const mockWorkos = {
  userManagement: {
    getAuthorizationUrl: workos.userManagement.getAuthorizationUrl as jest.Mock,
    authenticateWithCode: workos.userManagement.authenticateWithCode as jest.Mock,
    authenticateWithRefreshToken: workos.userManagement.authenticateWithRefreshToken as jest.Mock,
    revokeSession: workos.userManagement.revokeSession as jest.Mock,
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

    it('forwards a PKCE code challenge with the S256 method (audit #5)', async () => {
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue('https://auth.workos.com/authorize');

      await WorkOSService.getAuthorizationUrl('st', 'myapp://callback', 'challenge-abc');

      expect(mockWorkos.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'st',
          redirectUri: 'myapp://callback',
          codeChallenge: 'challenge-abc',
          codeChallengeMethod: 'S256',
        })
      );
    });

    it('omits the PKCE fields entirely when no challenge is given', async () => {
      mockWorkos.userManagement.getAuthorizationUrl.mockResolvedValue('https://auth.workos.com/authorize');

      await WorkOSService.getAuthorizationUrl();

      const arg = mockWorkos.userManagement.getAuthorizationUrl.mock.calls[0][0];
      expect(arg).not.toHaveProperty('codeChallenge');
      expect(arg).not.toHaveProperty('codeChallengeMethod');
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

    it('passes the PKCE code verifier through to WorkOS when given', async () => {
      mockWorkos.userManagement.authenticateWithCode.mockResolvedValue({ accessToken: 'a' });

      await WorkOSService.exchangeCodeForToken('auth-code', 'verifier-xyz');

      expect(mockWorkos.userManagement.authenticateWithCode).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        code: 'auth-code',
        codeVerifier: 'verifier-xyz',
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

  describe('revokeSession', () => {
    it('revokes the WorkOS session by id', async () => {
      mockWorkos.userManagement.revokeSession.mockResolvedValue(undefined);

      await WorkOSService.revokeSession('session_123');

      expect(mockWorkos.userManagement.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_123' });
    });

    it('propagates WorkOS errors', async () => {
      mockWorkos.userManagement.revokeSession.mockRejectedValue(new Error('WorkOS down'));

      await expect(WorkOSService.revokeSession('session_123')).rejects.toThrow('WorkOS down');
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
    const p2002 = (): Prisma.PrismaClientKnownRequestError =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });

    beforeEach(() => {
      delete process.env.ADMIN_EMAIL;
      delete process.env.ADMIN_EMAILS;
    });

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

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(player);

      const result = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('id', player.id);
      expect(result).toHaveProperty('email', 'newuser@example.com');
      // Looked up by WorkOS id first, then by email — never findFirst with OR
      expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(1, { where: { workosUserId: 'workos_123' } });
      expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(2, { where: { email: 'newuser@example.com' } });
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workosUserId: 'workos_123',
            email: 'newuser@example.com',
            name: 'New User',
            role: 'PLAYER',
            profilePictureUrl: 'https://example.com/avatar.jpg',
          }),
        })
      );
    });

    it('should grant ADMIN on create when the email is allowlisted', async () => {
      process.env.ADMIN_EMAIL = 'boss@example.com';
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(createPlayer());

      await WorkOSService.syncUser({ id: 'workos_admin', email: 'boss@example.com', emailVerified: true });

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN' }) })
      );
    });

    it('should update an existing user by WorkOS ID without overwriting in-app name/avatar (audit #25)', async () => {
      const existingUser = createPlayer({
        email: 'existing@example.com',
        name: 'Edited In App',
        workosUserId: 'workos_123',
        profilePictureUrl: 'https://cdn.example.com/my-upload.jpg',
      });
      const workosUser = {
        id: 'workos_123',
        email: 'existing@example.com',
        firstName: 'WorkOS',
        lastName: 'Name',
        emailVerified: true,
        profilePictureUrl: undefined,
      };

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue(existingUser);

      const result = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('name', 'Edited In App');
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: { emailVerified: true },
      });
    });

    it('should follow an email change made in WorkOS for a linked user', async () => {
      const existingUser = createPlayer({ email: 'old@example.com', workosUserId: 'workos_123' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...existingUser, email: 'new@example.com' });

      const result = await WorkOSService.syncUser({ id: 'workos_123', email: 'new@example.com', emailVerified: true });

      expect(result).toHaveProperty('email', 'new@example.com');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'new@example.com' }) })
      );
    });

    it('should fill in the avatar from WorkOS only when the local one is null', async () => {
      const existingUser = createPlayer({ workosUserId: 'workos_123', profilePictureUrl: null });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue(existingUser);

      await WorkOSService.syncUser({
        id: 'workos_123',
        email: existingUser.email,
        emailVerified: true,
        profilePictureUrl: 'https://workos.example.com/pic.jpg',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ profilePictureUrl: 'https://workos.example.com/pic.jpg' }),
        })
      );
    });

    it('should claim a pre-provisioned row by email and clear managed-player ownership (audit #2)', async () => {
      const existingUser = {
        ...createPlayer({ email: 'user@example.com', name: 'Roster Name' }),
        workosUserId: null,
        isManaged: true,
        managedById: 'coach-1',
      };
      const workosUser = {
        id: 'workos_456',
        email: 'user@example.com',
        firstName: 'New',
        lastName: 'Name',
        emailVerified: true,
      };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)          // by workosUserId
        .mockResolvedValueOnce(existingUser); // by email
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...existingUser,
        workosUserId: 'workos_456',
        isManaged: false,
        managedById: null,
      });

      const result = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('workosUserId', 'workos_456');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: {
          workosUserId: 'workos_456',
          emailVerified: true,
          isManaged: false,
          managedById: null,
        },
      });
      // Name set by the coach is kept; role is not touched for non-admin emails
      const data = (mockPrisma.user.update as jest.Mock).mock.calls[0][0].data;
      expect(data).not.toHaveProperty('name');
      expect(data).not.toHaveProperty('role');
    });

    it('should promote a pre-provisioned row to ADMIN on first link when the email is allowlisted', async () => {
      process.env.ADMIN_EMAILS = 'Boss@Example.com';
      const existingUser = { ...createPlayer({ email: 'boss@example.com' }), workosUserId: null };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...existingUser, role: 'ADMIN' });

      await WorkOSService.syncUser({ id: 'workos_admin', email: 'boss@example.com', emailVerified: true });

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN' }) })
      );
    });

    it('should refuse (409) to link an email already bound to a different WorkOS identity', async () => {
      const existingUser = createPlayer({ email: 'taken@example.com', workosUserId: 'workos_other' });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);

      await expect(
        WorkOSService.syncUser({ id: 'workos_new', email: 'taken@example.com', emailVerified: true })
      ).rejects.toBeInstanceOf(ConflictError);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('should map a unique-constraint race on create to ConflictError (not 500)', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockRejectedValue(p2002());

      await expect(
        WorkOSService.syncUser({ id: 'workos_new', email: 'race@example.com', emailVerified: true })
      ).rejects.toBeInstanceOf(ConflictError);
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

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
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
