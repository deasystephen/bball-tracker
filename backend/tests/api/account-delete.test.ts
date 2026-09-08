/**
 * API tests for account deletion (#444):
 *   DELETE /api/v1/auth/me               — self-service
 *   DELETE /api/v1/players/:id/account   — guardian deletes a managed child's record
 *
 * The service is mocked; these prove routing, gates, and the response
 * bodies (including the central handler's `last_head_coach` serialization).
 */
import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import { AccountService } from '../../src/services/account-service';
import { WorkOSService } from '../../src/services/workos-service';
import { isGuardianOf } from '../../src/utils/permissions';
import { ForbiddenError, LastHeadCoachError, NotFoundError } from '../../src/utils/errors';

const CALLER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const CHILD_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    req.user = {
      id: CALLER_ID,
      email: 'caller@example.com',
      name: 'Caller',
      role: 'PARENT',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));
jest.mock('../../src/services/account-service', () => ({
  AccountService: { deleteAccount: jest.fn(), exportUserData: jest.fn() },
}));
jest.mock('../../src/services/workos-service');
jest.mock('../../src/utils/permissions', () => ({
  ...jest.requireActual('../../src/utils/permissions'),
  isGuardianOf: jest.fn(),
}));

const mockAccount = AccountService as jest.Mocked<typeof AccountService>;
const mockWorkOS = WorkOSService as jest.Mocked<typeof WorkOSService>;
const mockIsGuardianOf = isGuardianOf as jest.Mock;

const AUTH = { Authorization: 'Bearer token' };
const DEV_AUTH = { Authorization: 'Bearer dev_abc' };

describe('DELETE /api/v1/auth/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.deleteAccount.mockResolvedValue({ success: true, identityDeleted: true, adminlessLeagueIds: [] });
    mockWorkOS.verifyToken.mockResolvedValue({ id: 'workos_1', sessionId: 'sess_1', expiresAt: 0 });
  });

  it('requires authentication', async () => {
    const res = await request(app).delete('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(mockAccount.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes the caller in self mode, passing the session id for the revoke fallback', async () => {
    const res = await request(app).delete('/api/v1/auth/me').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, identityDeleted: true });
    expect(mockAccount.deleteAccount).toHaveBeenCalledWith(CALLER_ID, {
      actorId: CALLER_ID,
      mode: 'self',
      sessionId: 'sess_1',
    });
  });

  it('does not look up a session id for a dev token', async () => {
    const res = await request(app).delete('/api/v1/auth/me').set(DEV_AUTH);

    expect(res.status).toBe(200);
    expect(mockWorkOS.verifyToken).not.toHaveBeenCalled();
    expect(mockAccount.deleteAccount).toHaveBeenCalledWith(CALLER_ID, {
      actorId: CALLER_ID,
      mode: 'self',
      sessionId: undefined,
    });
  });

  it('answers 400 last_head_coach with the team list (serialized by the central handler)', async () => {
    mockAccount.deleteAccount.mockRejectedValue(
      new LastHeadCoachError([
        { id: 't1', name: 'Lakers' },
        { id: 't2', name: 'Bulls' },
      ])
    );

    const res = await request(app).delete('/api/v1/auth/me').set(AUTH);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: expect.stringContaining('only Head Coach'),
      code: 'last_head_coach',
      teams: [
        { id: 't1', name: 'Lakers' },
        { id: 't2', name: 'Bulls' },
      ],
    });
  });

  it('reports identityDeleted:false when the provider call failed but the row is gone', async () => {
    mockAccount.deleteAccount.mockResolvedValue({ success: true, identityDeleted: false, adminlessLeagueIds: ['l1'] });

    const res = await request(app).delete('/api/v1/auth/me').set(AUTH);

    expect(res.status).toBe(200);
    // adminlessLeagueIds is operator information (log + runbook), never sent to the client
    expect(res.body).toEqual({ success: true, identityDeleted: false });
  });

  it('returns 500 without leaking details on an unexpected error', async () => {
    mockAccount.deleteAccount.mockRejectedValue(new Error('db down'));
    const res = await request(app).delete('/api/v1/auth/me').set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to delete account' });
  });
});

describe('DELETE /api/v1/players/:id/account', () => {
  const managedChild = { isManaged: true, workosUserId: null, deletedAt: null };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount.deleteAccount.mockResolvedValue({ success: true, identityDeleted: false, adminlessLeagueIds: [] });
    mockIsGuardianOf.mockResolvedValue(true);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(managedChild);
  });

  it('requires authentication', async () => {
    const res = await request(app).delete(`/api/v1/players/${CHILD_ID}/account`);
    expect(res.status).toBe(401);
  });

  it('rejects a non-UUID id before any lookup', async () => {
    const res = await request(app).delete('/api/v1/players/managed-bryce/account').set(AUTH);
    expect(res.status).toBe(400);
    expect(mockIsGuardianOf).not.toHaveBeenCalled();
  });

  it('lets a guardian delete a managed, unclaimed child in guardian mode', async () => {
    const res = await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockIsGuardianOf).toHaveBeenCalledWith(CALLER_ID, CHILD_ID);
    expect(mockAccount.deleteAccount).toHaveBeenCalledWith(CHILD_ID, { actorId: CALLER_ID, mode: 'guardian' });
  });

  it('answers 403 for a caller who is not a guardian of the player', async () => {
    mockIsGuardianOf.mockResolvedValue(false);
    const res = await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH);
    expect(res.status).toBe(403);
    expect(mockAccount.deleteAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['claimed (has a login)', { isManaged: true, workosUserId: 'workos_child', deletedAt: null }],
    ['not a managed record', { isManaged: false, workosUserId: null, deletedAt: null }],
  ])('answers 403 "only the account owner" for a child that is %s', async (_label, child) => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(child);
    const res = await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only the account owner can delete a claimed account');
    expect(mockAccount.deleteAccount).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown or already-deleted player', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    expect((await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH)).status).toBe(404);

    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ ...managedChild, deletedAt: new Date() });
    expect((await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH)).status).toBe(404);
    expect(mockAccount.deleteAccount).not.toHaveBeenCalled();
  });

  it('maps a service-level 403 (claimed under the lock) and 404 to their status codes', async () => {
    mockAccount.deleteAccount.mockRejectedValueOnce(new ForbiddenError('Only the account owner can delete a claimed account'));
    expect((await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH)).status).toBe(403);

    mockAccount.deleteAccount.mockRejectedValueOnce(new NotFoundError('Account not found'));
    expect((await request(app).delete(`/api/v1/players/${CHILD_ID}/account`).set(AUTH)).status).toBe(404);
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
