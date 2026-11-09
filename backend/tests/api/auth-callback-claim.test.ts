/**
 * `GET /auth/callback` claiming a pre-provisioned row, through the real route
 * → `WorkOSService.syncUser` → shared Prisma mock path (#907), and the wider
 * rule that no account exists without a verified email (#956: no new row, no
 * claim, no returning sign-in; the WorkOS session the exchange opened is
 * revoked). Only the WorkOS SDK is stubbed (`tests/support/workos-mock.ts`,
 * installed by `tests/setup.ts`): `authenticateWithCode` returns the identity
 * whose `emailVerified` decides the outcome.
 *
 * `tests/api/auth.test.ts` mocks the whole service, so it cannot show that a
 * refused claim writes nothing; this file can. "Row untouched" is asserted as
 * "no write method on any Prisma delegate was called": `isManaged`,
 * `managedById`, `workosUserId` and the row's team memberships can only change
 * through one of them.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { authRateLimit } from '../../src/api/middleware/rate-limit';
import { mockPrisma } from '../setup';
import { mockWorkOSClient } from '../support/workos-mock';

const ROW_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const COACH_ID = 'a7b8c9d0-e1f2-4456-a890-abcdef012345';
const EMAIL = 'roster-kid@example.test';

/** A player a coach added by email: no login yet, coach-managed. */
function preProvisionedRow(): Record<string, unknown> {
  const now = new Date();
  return {
    id: ROW_ID,
    workosUserId: null,
    email: EMAIL,
    name: 'Roster Kid',
    role: 'PLAYER',
    emailVerified: false,
    profilePictureUrl: null,
    isManaged: true,
    managedById: COACH_ID,
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
    notifyOnReplies: true,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** An unsigned compact JWT with the `sid` WorkOS puts on every access token. */
const ISSUED_ACCESS_TOKEN = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(
  JSON.stringify({ sub: 'workos_roster_kid', sid: 'session_issued' })
).toString('base64url')}.sig`;

function signInAs(emailVerified: boolean, email: string = EMAIL): void {
  mockWorkOSClient.userManagement.authenticateWithCode.mockResolvedValue({
    user: {
      id: 'workos_roster_kid',
      object: 'user',
      email,
      firstName: 'Roster',
      lastName: 'Kid',
      emailVerified,
      profilePictureUrl: null,
    },
    accessToken: ISSUED_ACCESS_TOKEN,
    refreshToken: 'refresh-token',
  });
}

/** Every Prisma write method that was called, as `model.method`. */
function prismaWrites(): string[] {
  const calls: string[] = [];
  for (const [model, delegate] of Object.entries(mockPrisma)) {
    if (typeof delegate !== 'object' || delegate === null) continue;
    for (const [method, fn] of Object.entries(delegate as Record<string, jest.Mock>)) {
      if (/^(create|update|upsert|delete)/.test(method) && fn.mock.calls.length > 0) {
        calls.push(`${model}.${method}`);
      }
    }
  }
  if (mockPrisma.$transaction.mock.calls.length > 0) calls.push('$transaction');
  if (mockPrisma.$executeRaw.mock.calls.length > 0) calls.push('$executeRaw');
  return calls;
}

describe('GET /api/v1/auth/callback claiming a pre-provisioned row (#907)', () => {
  beforeEach(() => {
    authRateLimit.resetKey('::ffff:127.0.0.1');
    authRateLimit.resetKey('127.0.0.1');
    // No row is linked to the signing-in identity; the email lookup (#955:
    // case-insensitive `findMany` through `emailEquals`) finds the pre-provisioned row.
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.user.findMany as jest.Mock).mockImplementation(({ where }: { where: { email?: unknown } }) =>
      Promise.resolve(where.email ? [preProvisionedRow()] : [])
    );
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('claims the row when WorkOS reports the email verified (unchanged behaviour)', async () => {
    signInAs(true);
    (mockPrisma.user.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      ...preProvisionedRow(),
      workosUserId: 'workos_roster_kid',
      emailVerified: true,
      isManaged: false,
      managedById: null,
    });

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      claimedInvite: true,
      wasManaged: true,
      user: { id: ROW_ID, email: EMAIL },
    });
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: ROW_ID, workosUserId: null, deletedAt: null },
      data: { workosUserId: 'workos_roster_kid', emailVerified: true, isManaged: false, managedById: null },
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses with 403 email_not_verified and writes nothing when the email is unverified', async () => {
    signInAs(false);
    mockWorkOSClient.userManagement.revokeSession.mockResolvedValue(undefined);

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 'email_not_verified',
      error: expect.stringContaining('not verified'),
    });
    // No session is handed out for the unverified identity
    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.body).not.toHaveProperty('refreshToken');
    // The coach's row keeps isManaged / managedById / memberships: nothing was written
    expect(prismaWrites()).toEqual([]);
    // ... and the WorkOS session the exchange opened is ended (#956)
    expect(mockWorkOSClient.userManagement.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_issued' });
  });

  it('still answers the 403 when WorkOS refuses to revoke the issued session', async () => {
    signInAs(false);
    mockWorkOSClient.userManagement.revokeSession.mockRejectedValue(new Error('WorkOS down'));

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'email_not_verified' });
    expect(prismaWrites()).toEqual([]);
  });
});

describe('GET /api/v1/auth/callback with an unverified email and no row to claim (#956)', () => {
  beforeEach(() => {
    authRateLimit.resetKey('::ffff:127.0.0.1');
    authRateLimit.resetKey('127.0.0.1');
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);
    mockWorkOSClient.userManagement.revokeSession.mockResolvedValue(undefined);
  });

  it('creates no account for a brand-new unverified identity', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    signInAs(false, 'newcomer@example.test');

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'email_not_verified' });
    expect(response.body).not.toHaveProperty('accessToken');
    expect(prismaWrites()).toEqual([]);
    expect(mockWorkOSClient.userManagement.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_issued' });
  });

  it('refuses a returning linked user whose address flipped to unverified, leaving the row as it was', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...preProvisionedRow(),
      workosUserId: 'workos_roster_kid',
      emailVerified: true,
      isManaged: false,
      managedById: null,
    });
    signInAs(false);

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'email_not_verified' });
    expect(response.body).not.toHaveProperty('accessToken');
    // emailVerified stays true from the last verified sign-in: nothing was written
    expect(prismaWrites()).toEqual([]);
    expect(mockWorkOSClient.userManagement.revokeSession).toHaveBeenCalledWith({ sessionId: 'session_issued' });
  });
});
