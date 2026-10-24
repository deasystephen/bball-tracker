/**
 * `GET /auth/callback` through the real route → `WorkOSService.syncUser` →
 * shared Prisma mock path, for the two sign-ins the WorkOS Staging →
 * Production key cutover (#24) depends on. Only the WorkOS SDK is stubbed
 * (`tests/support/workos-mock.ts`, installed by `tests/setup.ts`).
 *
 * - **Relink (#24).** Every production row carries a *staging* WorkOS user
 *   id. After the key switch, a returning user signs in with a new production
 *   identity whose id matches no row, and the email lookup finds their row
 *   still bound to the staging id. When production WorkOS answers 404 for that
 *   staging id and reports the email verified, the row is moved to the new
 *   identity: 200, same account, no 409 and no cutover alarm. When the old
 *   identity still exists, the 409 and its alarm stay.
 * - **Case (#955).** A WorkOS email in a different case from the stored
 *   address must find the row, not create a second account.
 *
 * `tests/api/auth.test.ts` mocks the whole service, so it cannot show which
 * row is written; this file can.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { authRateLimit } from '../../src/api/middleware/rate-limit';
import { ConflictError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';
import { mockPrisma } from '../setup';
import { mockWorkOSClient } from '../support/workos-mock';

jest.mock('../../src/utils/sentry', () => ({
  ...jest.requireActual('../../src/utils/sentry'),
  captureException: jest.fn(),
  captureRequestException: jest.fn(),
}));
import { captureException } from '../../src/utils/sentry';

const ROW_ID = 'b8c9d0e1-f2a3-4567-a901-bcdef0123456';
const STORED_EMAIL = 'coach.dana@example.test';
const STAGING_ID = 'user_01STAGINGIDENTITY0000000';
const PRODUCTION_ID = 'user_01PRODUCTIONIDENTITY00000';

function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id: ROW_ID,
    workosUserId: STAGING_ID,
    email: STORED_EMAIL,
    name: 'Dana Whitfield',
    role: 'COACH',
    emailVerified: true,
    profilePictureUrl: null,
    isManaged: false,
    managedById: null,
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
    notifyOnReplies: true,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function signInAs(identity: { id: string; email: string; emailVerified: boolean }): void {
  mockWorkOSClient.userManagement.authenticateWithCode.mockResolvedValue({
    user: { object: 'user', firstName: 'Dana', lastName: 'Whitfield', profilePictureUrl: null, ...identity },
    accessToken: 'production-access-token',
    refreshToken: 'production-refresh-token',
  });
}

/** The row the email lookup returns; nothing matches the new production id. */
function storedRow(row: Record<string, unknown>): void {
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([row]);
}

const notFound = (): Error => Object.assign(new Error('Not Found'), { status: 404 });

describe('GET /api/v1/auth/callback across the WorkOS key cutover (#24, #955)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    authRateLimit.resetKey('::ffff:127.0.0.1');
    authRateLimit.resetKey('127.0.0.1');
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // The owner turns the relink on for the cutover window (runbook).
    process.env.WORKOS_RELINK_UNKNOWN_IDENTITIES = 'true';
  });

  afterEach(() => {
    delete process.env.WORKOS_RELINK_UNKNOWN_IDENTITIES;
    mockWorkOSClient.userManagement.getUser.mockReset();
  });

  it('keeps the 409 when the relink is switched off, without asking WorkOS', async () => {
    delete process.env.WORKOS_RELINK_UNKNOWN_IDENTITIES;
    storedRow(userRow());
    signInAs({ id: PRODUCTION_ID, email: STORED_EMAIL, emailVerified: true });

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(409);
    expect(mockWorkOSClient.userManagement.getUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('relinks a staging-linked account on its first production sign-in (no 409, no alarm)', async () => {
    storedRow(userRow());
    signInAs({ id: PRODUCTION_ID, email: STORED_EMAIL, emailVerified: true });
    mockWorkOSClient.userManagement.getUser.mockRejectedValueOnce(notFound());
    (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue(userRow({ workosUserId: PRODUCTION_ID }));

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      accessToken: 'production-access-token',
      refreshToken: 'production-refresh-token',
      // A relink is the same account signing in again, not a claimed invite.
      claimedInvite: false,
      wasManaged: false,
      user: { id: ROW_ID, email: STORED_EMAIL, role: 'COACH' },
    });
    expect(mockWorkOSClient.userManagement.getUser).toHaveBeenCalledWith(STAGING_ID);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: ROW_ID, workosUserId: STAGING_ID, deletedAt: null },
      data: { workosUserId: PRODUCTION_ID, emailVerified: true },
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps the 409 and its alarm when the old identity still exists in this environment', async () => {
    storedRow(userRow());
    signInAs({ id: PRODUCTION_ID, email: STORED_EMAIL, emailVerified: true });
    mockWorkOSClient.userManagement.getUser.mockResolvedValueOnce({ id: STAGING_ID });

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(409);
    expect(response.body).not.toHaveProperty('accessToken');
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(ConflictError), { flow: 'auth-callback-conflict' });
    expect(errorSpy).toHaveBeenCalledWith(
      'Auth callback email linked to a different WorkOS user',
      expect.objectContaining({ status: 409 })
    );
  });

  it('refuses (409) to relink for an unverified email, without asking WorkOS', async () => {
    storedRow(userRow());
    signInAs({ id: PRODUCTION_ID, email: STORED_EMAIL, emailVerified: false });

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(409);
    expect(mockWorkOSClient.userManagement.getUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('answers 503 and writes nothing when WorkOS cannot say whether the old identity exists', async () => {
    storedRow(userRow());
    signInAs({ id: PRODUCTION_ID, email: STORED_EMAIL, emailVerified: true });
    mockWorkOSClient.userManagement.getUser.mockRejectedValueOnce(
      Object.assign(new Error('Service Unavailable'), { status: 503 })
    );

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(503);
    expect(response.body).not.toHaveProperty('accessToken');
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    // Not the cutover signature: a WorkOS outage must not look like one.
    expect(captureException).not.toHaveBeenCalledWith(expect.anything(), { flow: 'auth-callback-conflict' });
  });

  it('claims a lower-case pre-provisioned row for a mixed-case WorkOS email (#955)', async () => {
    const row = userRow({ workosUserId: null, role: 'PLAYER', isManaged: true, managedById: 'c9d0e1f2-a3b4-4678-a012-cdef01234567' });
    storedRow(row);
    signInAs({ id: PRODUCTION_ID, email: 'Coach.Dana@Example.TEST', emailVerified: true });
    (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      ...row,
      workosUserId: PRODUCTION_ID,
      isManaged: false,
      managedById: null,
    });

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ claimedInvite: true, wasManaged: true, user: { id: ROW_ID, email: STORED_EMAIL } });
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { email: { equals: STORED_EMAIL, mode: 'insensitive' }, deletedAt: null },
      take: 2,
    });
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ROW_ID, workosUserId: null, deletedAt: null } })
    );
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('stores a brand-new account under the lower-cased email (#955)', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);
    signInAs({ id: PRODUCTION_ID, email: 'New.Parent@Example.TEST', emailVerified: true });
    (mockPrisma.user.create as jest.Mock).mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(userRow({ ...data, id: ROW_ID }))
    );

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(200);
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'new.parent@example.test' }) })
    );
    expect(response.body.user.email).toBe('new.parent@example.test');
  });
});
