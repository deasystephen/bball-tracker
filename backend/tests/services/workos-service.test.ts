/**
 * Unit tests for WorkOSService
 */

jest.mock('../../src/utils/workos-client', () =>
  jest.requireActual('../support/workos-mock').mockWorkOSClientModule({
    assertWorkOSConfig: (): void => mockAssertWorkOSConfig(),
    getWorkOSJwks: (): unknown => mockGetWorkOSJwks(),
  }));

import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, errors as joseErrors, type JWK, type KeyLike } from 'jose';

const mockGetWorkOSJwks = jest.fn();
const mockAssertWorkOSConfig = jest.fn();

import { Prisma } from '@prisma/client';
import { WorkOSService } from '../../src/services/workos-service';
import { ConflictError, EmailNotVerifiedError } from '../../src/utils/errors';
import { mockPrisma } from '../setup';
import { createPlayer, uniqueViolation, type UserData } from '../factories';

import { mockWorkOSClient } from '../support/workos-mock';

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
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?provider=authkit'
      );

      const result = await WorkOSService.getAuthorizationUrl();

      expect(result).toBe('https://auth.workos.com/authorize?provider=authkit');
      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'test-client-id',
          redirectUri: 'http://localhost:3000/auth/callback',
          provider: 'authkit',
        })
      );
    });

    it('should include state parameter if provided', async () => {
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize?state=test-state'
      );

      const result = await WorkOSService.getAuthorizationUrl('test-state');

      expect(result).toContain('state=test-state');
      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'test-state',
        })
      );
    });

    it('forwards a PKCE code challenge with the S256 method (audit #5)', async () => {
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue('https://auth.workos.com/authorize');

      await WorkOSService.getAuthorizationUrl('st', 'myapp://callback', 'challenge-abc');

      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'st',
          redirectUri: 'myapp://callback',
          codeChallenge: 'challenge-abc',
          codeChallengeMethod: 'S256',
        })
      );
    });

    it('omits the PKCE fields entirely when no challenge is given', async () => {
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue('https://auth.workos.com/authorize');

      await WorkOSService.getAuthorizationUrl();

      const arg = mockWorkOSClient.userManagement.getAuthorizationUrl.mock.calls[0][0];
      expect(arg).not.toHaveProperty('codeChallenge');
      expect(arg).not.toHaveProperty('codeChallengeMethod');
    });

    it('should use custom redirect URI if provided', async () => {
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl(undefined, 'myapp://callback');

      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUri: 'myapp://callback',
        })
      );
    });

    it('should use connection ID if provided in environment', async () => {
      process.env.WORKOS_CONNECTION_ID = 'conn_123';
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl();

      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn_123',
        })
      );
    });

    it('should use organization ID if connection ID not provided', async () => {
      process.env.WORKOS_ORGANIZATION_ID = 'org_123';
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl();

      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org_123',
        })
      );
    });

    it('should use provider from environment if set', async () => {
      process.env.WORKOS_PROVIDER = 'GoogleOAuth';
      mockWorkOSClient.userManagement.getAuthorizationUrl.mockResolvedValue(
        'https://auth.workos.com/authorize'
      );

      await WorkOSService.getAuthorizationUrl();

      expect(mockWorkOSClient.userManagement.getAuthorizationUrl).toHaveBeenCalledWith(
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
      mockWorkOSClient.userManagement.authenticateWithCode.mockResolvedValue(mockResponse);

      const result = await WorkOSService.exchangeCodeForToken('auth-code');

      expect(result).toEqual(mockResponse);
      expect(mockWorkOSClient.userManagement.authenticateWithCode).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        code: 'auth-code',
      });
    });

    it('passes the PKCE code verifier through to WorkOS when given', async () => {
      mockWorkOSClient.userManagement.authenticateWithCode.mockResolvedValue({ accessToken: 'a' });

      await WorkOSService.exchangeCodeForToken('auth-code', 'verifier-xyz');

      expect(mockWorkOSClient.userManagement.authenticateWithCode).toHaveBeenCalledWith({
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
      mockWorkOSClient.userManagement.authenticateWithRefreshToken.mockResolvedValue(mockResponse);

      const result = await WorkOSService.refreshSession('old-refresh-token');

      expect(result).toEqual(mockResponse);
      expect(mockWorkOSClient.userManagement.authenticateWithRefreshToken).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        refreshToken: 'old-refresh-token',
      });
    });

    it('should propagate WorkOS errors so the route can map them to 401', async () => {
      mockWorkOSClient.userManagement.authenticateWithRefreshToken.mockRejectedValue(new Error('invalid_grant'));
      await expect(WorkOSService.refreshSession('bad')).rejects.toThrow('invalid_grant');
    });
  });

  describe('deleteUser (#444)', () => {
    it('deletes the WorkOS user by id (account deletion, after the local commit)', async () => {
      mockWorkOSClient.userManagement.deleteUser.mockResolvedValue(undefined);

      await WorkOSService.deleteUser('user_123');

      expect(mockWorkOSClient.userManagement.deleteUser).toHaveBeenCalledWith('user_123');
    });

    it('propagates provider failures to the caller (AccountService reports identityDeleted:false)', async () => {
      mockWorkOSClient.userManagement.deleteUser.mockRejectedValue(new Error('workos down'));

      await expect(WorkOSService.deleteUser('user_123')).rejects.toThrow('workos down');
    });
  });

  describe('revokeSession', () => {
    it('revokes the WorkOS session by id', async () => {
      mockWorkOSClient.userManagement.revokeSession.mockResolvedValue(undefined);

      await WorkOSService.revokeSession('session_123');

      expect(mockWorkOSClient.userManagement.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_123' });
    });

    it('propagates WorkOS errors', async () => {
      mockWorkOSClient.userManagement.revokeSession.mockRejectedValue(new Error('WorkOS down'));

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
      mockWorkOSClient.userManagement.getUser.mockResolvedValue(mockUser);

      const result = await WorkOSService.getUser('user_123');

      expect(result).toEqual(mockUser);
      expect(mockWorkOSClient.userManagement.getUser).toHaveBeenCalledWith('user_123');
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
      mockWorkOSClient.userManagement.listUsers.mockResolvedValue(mockUsers);

      const result = await WorkOSService.listUsers();

      expect(result).toEqual(mockUsers);
      expect(mockWorkOSClient.userManagement.listUsers).toHaveBeenCalled();
    });

    it('should pass options to list users', async () => {
      const mockUsers = {
        data: [{ id: 'user_1', email: 'specific@example.com' }],
        listMetadata: { after: null, before: null },
      };
      mockWorkOSClient.userManagement.listUsers.mockResolvedValue(mockUsers);

      await WorkOSService.listUsers({ email: 'specific@example.com', limit: 10 });

      expect(mockWorkOSClient.userManagement.listUsers).toHaveBeenCalledWith({
        email: 'specific@example.com',
        limit: 10,
      });
    });
  });

  describe('syncUser', () => {
    const p2002 = (): Prisma.PrismaClientKnownRequestError => uniqueViolation('User_email_key');

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

      const { user: result } = await WorkOSService.syncUser(workosUser);

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
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue(existingUser);

      const { user: result } = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('name', 'Edited In App');
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
      // Guarded write (#444 D9): a row deleted between the read and this write
      // must not be re-identified, so the update is conditioned on deletedAt.
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: existingUser.id, deletedAt: null },
        data: { emailVerified: true },
      });
    });

    it('should follow an email change made in WorkOS for a linked user', async () => {
      const existingUser = createPlayer({ email: 'old@example.com', workosUserId: 'workos_123' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...existingUser, email: 'new@example.com' });

      const { user: result } = await WorkOSService.syncUser({ id: 'workos_123', email: 'new@example.com', emailVerified: true });

      expect(result).toHaveProperty('email', 'new@example.com');
      // A bounce recorded against the old address says nothing about the new one (#449).
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'new@example.com',
            emailSuppressedAt: null,
            emailSuppressedReason: null,
          }),
        })
      );
    });

    it('leaves the email delivery state alone when the email did not change (#449)', async () => {
      const existingUser = createPlayer({ email: 'same@example.com', workosUserId: 'workos_123' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue(existingUser);

      await WorkOSService.syncUser({ id: 'workos_123', email: 'same@example.com', emailVerified: true });

      const [{ data }] = (mockPrisma.user.updateMany as jest.Mock).mock.calls[0] as [{ data: object }];
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('emailSuppressedAt');
      expect(data).not.toHaveProperty('emailSuppressedReason');
    });

    it('should fill in the avatar from WorkOS only when the local one is null', async () => {
      const existingUser = createPlayer({ workosUserId: 'workos_123', profilePictureUrl: null });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue(existingUser);

      await WorkOSService.syncUser({
        id: 'workos_123',
        email: existingUser.email,
        emailVerified: true,
        profilePictureUrl: 'https://workos.example.com/pic.jpg',
      });

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ profilePictureUrl: 'https://workos.example.com/pic.jpg' }),
        })
      );
    });

    it('creates a fresh account when the linked row was deleted during sign-in (#444 D9)', async () => {
      const existingUser = createPlayer({ email: 'gone@example.com', workosUserId: 'workos_123' });
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(existingUser) // by workosUserId (read before the deletion committed)
        .mockResolvedValueOnce(null); // by email: the tombstone has no email
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ ...existingUser, id: 'fresh-id' });

      const { user: result } = await WorkOSService.syncUser({ id: 'workos_123', email: 'gone@example.com', emailVerified: true });

      expect(result).toHaveProperty('id', 'fresh-id');
      expect(mockPrisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
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
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...existingUser,
        workosUserId: 'workos_456',
        isManaged: false,
        managedById: null,
      });

      const { user: result } = await WorkOSService.syncUser(workosUser);

      expect(result).toHaveProperty('workosUserId', 'workos_456');
      // Claim-guarded (RT4 shape) AND deletion-guarded (#444 D9)
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: existingUser.id, workosUserId: null, deletedAt: null },
        data: {
          workosUserId: 'workos_456',
          emailVerified: true,
          isManaged: false,
          managedById: null,
        },
      });
      // Name set by the coach is kept; role is not touched for non-admin emails
      const data = (mockPrisma.user.updateMany as jest.Mock).mock.calls[0][0].data;
      expect(data).not.toHaveProperty('name');
      expect(data).not.toHaveProperty('role');
    });

    it('creates a fresh account when the pre-provisioned row was deleted or claimed during sign-in (#444 D9)', async () => {
      const existingUser = { ...createPlayer({ email: 'user@example.com' }), workosUserId: null };
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ ...existingUser, id: 'fresh-id', workosUserId: 'workos_456' });

      const { user: result } = await WorkOSService.syncUser({ id: 'workos_456', email: 'user@example.com', emailVerified: true });

      expect(result).toHaveProperty('id', 'fresh-id');
      expect(mockPrisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('should promote a pre-provisioned row to ADMIN on first link when the email is allowlisted', async () => {
      process.env.ADMIN_EMAILS = 'Boss@Example.com';
      const existingUser = { ...createPlayer({ email: 'boss@example.com' }), workosUserId: null };

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...existingUser, role: 'ADMIN' });

      await WorkOSService.syncUser({ id: 'workos_admin', email: 'boss@example.com', emailVerified: true });

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
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
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    describe('unverified email (#907)', () => {
      const managedRow = (): UserData & { isManaged: boolean; managedById: string | null } => ({
        ...createPlayer({ email: 'kid@example.com', name: 'Roster Name' }),
        workosUserId: null,
        isManaged: true,
        managedById: 'coach-1',
      });

      it('refuses (403 email_not_verified) to claim a pre-provisioned row and writes nothing', async () => {
        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(null)           // by workosUserId
          .mockResolvedValueOnce(managedRow());  // by email

        const attempt = WorkOSService.syncUser({ id: 'workos_unverified', email: 'kid@example.com', emailVerified: false });

        await expect(attempt).rejects.toBeInstanceOf(EmailNotVerifiedError);
        await expect(attempt).rejects.toMatchObject({ statusCode: 403, code: 'email_not_verified' });
        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
      });

      it('does not let an allowlisted admin email bypass the check', async () => {
        process.env.ADMIN_EMAILS = 'kid@example.com';
        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(managedRow());

        await expect(
          WorkOSService.syncUser({ id: 'workos_unverified', email: 'kid@example.com', emailVerified: false })
        ).rejects.toBeInstanceOf(EmailNotVerifiedError);
        expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
      });

      it('still answers 409 when the email is linked to a different identity', async () => {
        (mockPrisma.user.findUnique as jest.Mock)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(createPlayer({ email: 'kid@example.com', workosUserId: 'workos_other' }));

        await expect(
          WorkOSService.syncUser({ id: 'workos_unverified', email: 'kid@example.com', emailVerified: false })
        ).rejects.toBeInstanceOf(ConflictError);
      });

      it('still refreshes an already-linked user (the gate is only on the claim)', async () => {
        const linked = createPlayer({ email: 'linked@example.com', workosUserId: 'workos_linked', profilePictureUrl: 'x' });
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(linked);
        (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({ ...linked, emailVerified: false });

        const result = await WorkOSService.syncUser({ id: 'workos_linked', email: 'linked@example.com', emailVerified: false });

        expect(result.claimedInvite).toBe(false);
        expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
          where: { id: linked.id, deletedAt: null },
          data: { emailVerified: false },
        });
      });

      it('still creates a brand-new account (no row to claim)', async () => {
        (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
        const created = createPlayer({ email: 'new@example.com', workosUserId: 'workos_new' });
        (mockPrisma.user.create as jest.Mock).mockResolvedValue(created);

        const result = await WorkOSService.syncUser({ id: 'workos_new', email: 'new@example.com', emailVerified: false });

        expect(result).toEqual({ user: created, claimedInvite: false, wasManaged: false });
        expect(mockPrisma.user.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ workosUserId: 'workos_new', emailVerified: false }),
        });
      });
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

    // Outcome flags (#790): which branch produced the row.
    it('reports a brand-new account as not claimed', async () => {
      const player = createPlayer({ email: 'fresh@example.com', workosUserId: 'workos_new' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue(player);

      const result = await WorkOSService.syncUser({
        id: 'workos_new',
        email: 'fresh@example.com',
        emailVerified: true,
      });

      expect(result).toEqual({ user: player, claimedInvite: false, wasManaged: false });
    });

    it('reports a returning linked user as not claimed', async () => {
      const existingUser = createPlayer({ workosUserId: 'workos_123' });
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue(existingUser);

      const result = await WorkOSService.syncUser({
        id: 'workos_123',
        email: existingUser.email,
        emailVerified: true,
      });

      expect(result).toEqual({ user: existingUser, claimedInvite: false, wasManaged: false });
    });

    it.each([
      { isManaged: true, label: 'a coach-managed player' },
      { isManaged: false, label: 'an invited, unmanaged row' },
    ])('reports a claimed pre-provisioned row ($label) with its prior managed flag', async ({ isManaged }) => {
      const existingUser = {
        ...createPlayer({ email: 'invited@example.com' }),
        workosUserId: null,
        isManaged,
        managedById: isManaged ? 'coach-1' : null,
      };
      const claimedRow = { ...existingUser, workosUserId: 'workos_456', isManaged: false, managedById: null };
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // by workosUserId
        .mockResolvedValueOnce(existingUser); // by email
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue(claimedRow);

      const result = await WorkOSService.syncUser({
        id: 'workos_456',
        email: 'invited@example.com',
        emailVerified: true,
      });

      expect(result).toEqual({ user: claimedRow, claimedInvite: true, wasManaged: isManaged });
    });

    it('reports a lost claim race that fell through to a create as not claimed', async () => {
      const existingUser = { ...createPlayer({ email: 'user@example.com' }), workosUserId: null, isManaged: true };
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);
      (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({ ...existingUser, id: 'fresh-id' });

      const result = await WorkOSService.syncUser({
        id: 'workos_456',
        email: 'user@example.com',
        emailVerified: true,
      });

      expect(result.user).toHaveProperty('id', 'fresh-id');
      expect(result.claimedInvite).toBe(false);
      expect(result.wasManaged).toBe(false);
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
      // `iat` is surfaced so the socket re-auth can bound an outage hold (#49).
      expect(typeof result?.issuedAt).toBe('number');
      expect(result!.expiresAt).toBeGreaterThan(result!.issuedAt as number);
      // Verification is purely local — no WorkOS API round-trip per request.
      expect(mockWorkOSClient.userManagement.getUser).not.toHaveBeenCalled();
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

    it('lets a config error through unchanged instead of answering 503', async () => {
      mockAssertWorkOSConfig.mockImplementationOnce(() => {
        throw new Error('WORKOS_CLIENT_ID environment variable is required');
      });
      const token = await sign({ sub: 'user_123' });

      const error = await WorkOSService.verifyToken(token).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { statusCode?: number }).statusCode).toBeUndefined();
      expect((error as Error).message).toContain('WORKOS_CLIENT_ID');
    });
  });
});
