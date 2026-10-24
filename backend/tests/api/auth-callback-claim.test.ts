/**
 * `GET /auth/callback` claiming a pre-provisioned row, through the real route
 * → `WorkOSService.syncUser` → shared Prisma mock path (#907). Only the WorkOS
 * SDK is stubbed (`tests/support/workos-mock.ts`, installed by `tests/setup.ts`):
 * `authenticateWithCode` returns the identity whose `emailVerified` decides
 * whether the coach-added row may be claimed.
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

function signInAs(emailVerified: boolean): void {
  mockWorkOSClient.userManagement.authenticateWithCode.mockResolvedValue({
    user: {
      id: 'workos_roster_kid',
      object: 'user',
      email: EMAIL,
      firstName: 'Roster',
      lastName: 'Kid',
      emailVerified,
      profilePictureUrl: null,
    },
    accessToken: 'access-token',
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
    (mockPrisma.user.findUnique as jest.Mock).mockImplementation(
      ({ where }: { where: { workosUserId?: string; email?: string } }) =>
        Promise.resolve(where.email === EMAIL ? preProvisionedRow() : null)
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

    const response = await request(app).get('/api/v1/auth/callback').query({ code: 'auth-code' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 'email_not_verified',
      error: expect.stringContaining('Verify your email'),
    });
    // No session is handed out for the unverified identity
    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.body).not.toHaveProperty('refreshToken');
    // The coach's row keeps isManaged / managedById / memberships: nothing was written
    expect(prismaWrites()).toEqual([]);
  });
});
