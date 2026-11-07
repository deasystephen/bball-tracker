/**
 * API tests for the age screen (#981, part of #980):
 *   POST /api/v1/auth/age-confirmation — the neutral month/year answer
 *   the age gate in `authenticate` — 403 `age_confirmation_required` on every
 *   other authenticated route until the answer is recorded
 *
 * The REAL `authenticate` runs (only `WorkOSService` and Prisma are mocked),
 * so the gate, its exemptions and the `AGE_GATE_ENFORCED` flag are exercised
 * as production runs them. `AccountService` is mocked: the row-level outcomes
 * of the under-age branch are proved in
 * `tests/integration/age-refusal.db.test.ts`.
 */
import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import { WorkOSService } from '../../src/services/workos-service';
import { AccountService } from '../../src/services/account-service';
import { authRateLimit } from '../../src/api/middleware/rate-limit';
import { AGE_GATE_EXEMPT } from '../../src/api/auth/middleware';

jest.mock('../../src/services/workos-service');
jest.mock('../../src/services/account-service', () => ({
  AccountService: { confirmAge: jest.fn(), refuseUnderage: jest.fn() },
}));

const mockWorkOS = WorkOSService as jest.Mocked<typeof WorkOSService>;
const mockAccount = AccountService as jest.Mocked<typeof AccountService>;

const USER_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef12';
const AUTH = { Authorization: 'Bearer valid-token' };

/** The row `authenticate` resolves (`AUTH_USER_SELECT`), unconfirmed unless told otherwise. */
function authRow(ageConfirmedAt: Date | null = null, ageRefusedAt: Date | null = null): Record<string, unknown> {
  return {
    id: USER_ID,
    email: 'newcomer@example.test',
    name: 'Newcomer',
    role: 'PLAYER',
    subscriptionTier: 'FREE',
    subscriptionExpiresAt: null,
    ageConfirmedAt,
    ageRefusedAt,
    // GET /auth/me re-reads the row through SESSION_USER_SELECT.
    profilePictureUrl: null,
    notifyOnReplies: true,
    createdAt: new Date('2026-11-01T00:00:00Z'),
  };
}

const THIS_YEAR = new Date().getUTCFullYear();
/** Clearly an adult anywhere: born 30 years ago. */
const ADULT = { birthMonth: 6, birthYear: THIS_YEAR - 30 };
/** 10 years old: under every threshold. */
const CHILD = { birthMonth: 6, birthYear: THIS_YEAR - 10 };
/** 14 years old last January: 13+ (US) but under 16 (EU/UK/CH). */
const FOURTEEN = { birthMonth: 1, birthYear: THIS_YEAR - 14 };

describe('the age gate and POST /api/v1/auth/age-confirmation', () => {
  const originalFlag = process.env.AGE_GATE_ENFORCED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AGE_GATE_ENFORCED;
    authRateLimit.resetKey('::ffff:127.0.0.1');
    authRateLimit.resetKey('127.0.0.1');
    mockWorkOS.verifyToken.mockResolvedValue({ id: 'workos_new', sessionId: 'sess_1', expiresAt: 0 });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(authRow());
    (mockPrisma.leagueAdmin.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
    mockAccount.confirmAge.mockResolvedValue(undefined);
    mockAccount.refuseUnderage.mockResolvedValue({ outcome: 'erased', identityDeleted: true });
  });

  afterAll((done) => {
    if (originalFlag === undefined) delete process.env.AGE_GATE_ENFORCED;
    else process.env.AGE_GATE_ENFORCED = originalFlag;
    if (httpServer?.listening) httpServer.close(() => done());
    else done();
  });

  describe('the gate', () => {
    it('answers 403 age_confirmation_required on a protected route for an unconfirmed account', async () => {
      const res = await request(app).get('/api/v1/auth/entitlements').set(AUTH);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Please confirm your age to continue', code: 'age_confirmation_required' });
    });

    it('gates every router, not only /auth', async () => {
      const res = await request(app).get('/api/v1/teams').set(AUTH);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('age_confirmation_required');
    });

    it('lets an unconfirmed account read who it is, and says ageConfirmed: false', async () => {
      const res = await request(app).get('/api/v1/auth/me').set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: USER_ID, ageConfirmed: false });
      expect(res.body.user).not.toHaveProperty('ageConfirmedAt');
    });

    it('lets an unconfirmed account sign out (the logout sequence needs both routes)', async () => {
      mockWorkOS.revokeSession.mockResolvedValue(undefined);
      (mockPrisma.pushToken.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      const logout = await request(app).post('/api/v1/auth/logout').set(AUTH);
      expect(logout.status).toBe(200);
      const push = await request(app).delete('/api/v1/auth/push-token').set(AUTH).send({ token: 'ExponentPushToken[x]' });
      expect(push.status).not.toBe(403);
    });

    it('the exemption list is exactly the routes the age screen needs', () => {
      expect([...AGE_GATE_EXEMPT].sort()).toEqual([
        'DELETE /auth/me',
        'DELETE /auth/push-token',
        'GET /auth/me',
        'POST /auth/age-confirmation',
        'POST /auth/logout',
      ]);
    });

    it('passes a confirmed account through', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(authRow(new Date()));
      const res = await request(app).get('/api/v1/auth/entitlements').set(AUTH);
      expect(res.status).toBe(200);
    });

    it('is relaxed while AGE_GATE_ENFORCED=false, and the payload still says ageConfirmed: false', async () => {
      process.env.AGE_GATE_ENFORCED = 'false';
      const res = await request(app).get('/api/v1/auth/entitlements').set(AUTH);
      expect(res.status).toBe(200);
      const me = await request(app).get('/api/v1/auth/me').set(AUTH);
      expect(me.body.user.ageConfirmed).toBe(false);
    });

    it('is enforced when the flag is unset or anything but "false"', async () => {
      process.env.AGE_GATE_ENFORCED = 'true';
      expect((await request(app).get('/api/v1/auth/entitlements').set(AUTH)).status).toBe(403);
      process.env.AGE_GATE_ENFORCED = 'no';
      expect((await request(app).get('/api/v1/auth/entitlements').set(AUTH)).status).toBe(403);
    });
  });

  describe('POST /api/v1/auth/age-confirmation', () => {
    it('requires authentication', async () => {
      const res = await request(app).post('/api/v1/auth/age-confirmation').send(ADULT);
      expect(res.status).toBe(401);
      expect(mockAccount.confirmAge).not.toHaveBeenCalled();
    });

    it('records an adult answer and says confirmed', async () => {
      const res = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(ADULT);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ confirmed: true });
      expect(mockAccount.confirmAge).toHaveBeenCalledWith(USER_ID);
      expect(mockAccount.refuseUnderage).not.toHaveBeenCalled();
    });

    it('refuses a child, undoes the sign-in, and says nothing about the answer', async () => {
      const res = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(CHILD);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'Accounts are for ages 13 and up (16 in the EU, UK and Switzerland)',
        code: 'under_minimum_age',
        pendingOperator: false,
      });
      expect(mockAccount.refuseUnderage).toHaveBeenCalledWith(USER_ID, { sessionId: 'sess_1' });
      expect(mockAccount.confirmAge).not.toHaveBeenCalled();
    });

    it('applies the 16 threshold to an EU/UK/CH region and 13 elsewhere', async () => {
      const us = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send({ ...FOURTEEN, regionCode: 'US' });
      expect(us.status).toBe(200);
      const de = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send({ ...FOURTEEN, regionCode: 'de' });
      expect(de.status).toBe(403);
      expect(de.body.code).toBe('under_minimum_age');
      const none = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(FOURTEEN);
      expect(none.status).toBe(200);
    });

    it('answers 403 whatever refuseUnderage did, with pendingOperator only when the operator must finish', async () => {
      for (const outcome of ['unclaimed', 'deleted', 'erased'] as const) {
        mockAccount.refuseUnderage.mockResolvedValueOnce({ outcome, identityDeleted: false });
        const res = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(CHILD);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          error: 'Accounts are for ages 13 and up (16 in the EU, UK and Switzerland)',
          code: 'under_minimum_age',
          pendingOperator: false,
        });
      }
      mockAccount.refuseUnderage.mockResolvedValueOnce({ outcome: 'pending_operator', identityDeleted: false });
      const held = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(CHILD);
      expect(held.status).toBe(403);
      expect(held.body).toEqual({
        error: 'Accounts are for ages 13 and up (16 in the EU, UK and Switzerland)',
        code: 'under_minimum_age',
        pendingOperator: true,
      });
    });

    it('refuses a second answer, whatever it says, once a refusal awaits the operator (no retry within the token lifetime)', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(authRow(null, new Date()));
      const res = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(ADULT);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('under_minimum_age');
      expect(res.body.pendingOperator).toBe(true);
      expect(mockAccount.confirmAge).not.toHaveBeenCalled();
      expect(mockAccount.refuseUnderage).not.toHaveBeenCalled();
      // And every other route stays shut, flag or no flag.
      process.env.AGE_GATE_ENFORCED = 'false';
      const gated = await request(app).get('/api/v1/auth/entitlements').set(AUTH);
      expect(gated.status).toBe(403);
      expect(gated.body.code).toBe('age_confirmation_required');
    });

    it('is a no-op 200 once the account is confirmed', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(authRow(new Date()));
      const res = await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send(CHILD);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ confirmed: true, alreadyConfirmed: true });
      expect(mockAccount.confirmAge).not.toHaveBeenCalled();
      expect(mockAccount.refuseUnderage).not.toHaveBeenCalled();
    });

    it('answers 400 on a malformed body, naming the field and never the value', async () => {
      const res = await request(app)
        .post('/api/v1/auth/age-confirmation')
        .set(AUTH)
        .send({ birthMonth: 42, birthYear: 1990 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Birth month');
      expect(JSON.stringify(res.body)).not.toContain('42');
      expect((await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send({})).status).toBe(400);
      expect(mockAccount.confirmAge).not.toHaveBeenCalled();
    });

    it('passes no session id for a dev token', async () => {
      process.env.NODE_ENV = 'development';
      try {
        const token = `dev_${Buffer.from(JSON.stringify({ userId: USER_ID, exp: Date.now() + 60_000 })).toString('base64')}`;
        const res = await request(app)
          .post('/api/v1/auth/age-confirmation')
          .set({ Authorization: `Bearer ${token}` })
          .send(CHILD);
        expect(res.status).toBe(403);
        expect(mockAccount.refuseUnderage).toHaveBeenCalledWith(USER_ID, { sessionId: undefined });
        expect(mockWorkOS.verifyToken).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = 'test';
      }
    });

    it('never writes the answer to a log line', async () => {
      const lines: string[] = [];
      const logSpy = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      const errSpy = jest.spyOn(console, 'error').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send({ birthMonth: 7, birthYear: 1987 });
        await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send({ birthMonth: 7, birthYear: THIS_YEAR - 9 });
        await request(app).post('/api/v1/auth/age-confirmation').set(AUTH).send({ birthMonth: 99, birthYear: 1987 });
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      const joined = lines.join('\n');
      expect(joined).not.toContain('1987');
      expect(joined).not.toContain(String(THIS_YEAR - 9));
      expect(joined).not.toContain('birthMonth');
      expect(joined).not.toContain('"99');
    });
  });
});
