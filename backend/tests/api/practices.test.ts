/**
 * Practice scheduling API (#33): route → Zod → PracticeService /
 * PracticeSeriesService → shared Prisma mock. Authentication and the access
 * predicates are stubbed so each case names the gate it exercises; the real
 * predicates and queries run in `tests/integration/practice-schedule.db.test.ts`.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { mockPrisma } from '../setup';
import { canAccessTeam, hasTeamPermission, isGuardianOf, isSystemAdmin } from '../../src/utils/permissions';
import type { AuthUser } from '../support/auth-fixtures';

const CHILD_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEAM_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const SESSION_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const SERIES_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';

let mockCaller: Partial<AuthUser> = {};

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    const { authUser } = jest.requireActual('../support/auth-fixtures');
    // The fixture's default id is the coach's.
    req.user = authUser(mockCaller);
    next();
  }),
}));

jest.mock('../../src/utils/permissions', () => ({
  ...jest.requireActual('../../src/utils/permissions'),
  canAccessTeam: jest.fn(),
  hasTeamPermission: jest.fn(),
  isGuardianOf: jest.fn(),
  isSystemAdmin: jest.fn(),
  readableTeamsWhere: jest.fn().mockResolvedValue({ OR: [] }),
}));

const PREMIUM = { subscriptionTier: 'PREMIUM' as const, subscriptionExpiresAt: new Date('2099-01-01T00:00:00Z') };

function practiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    teamId: TEAM_ID,
    seriesId: null,
    type: 'PRACTICE',
    title: null,
    location: 'Main gym',
    notes: null,
    startsAt: new Date('2030-01-15T23:00:00Z'),
    durationMinutes: 90,
    timezone: 'America/New_York',
    status: 'SCHEDULED',
    isException: false,
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    team: { id: TEAM_ID, name: 'Lakers' },
    series: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockCaller = { ...PREMIUM };
  (canAccessTeam as jest.Mock).mockResolvedValue(true);
  (hasTeamPermission as jest.Mock).mockResolvedValue(true);
  (isGuardianOf as jest.Mock).mockResolvedValue(false);
  (isSystemAdmin as jest.Mock).mockResolvedValue(false);
  mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM_ID });
});

describe('POST /api/v1/practices', () => {
  const body = {
    teamId: TEAM_ID,
    location: 'Main gym',
    startsAt: '2030-01-15T18:00:00-05:00',
    durationMinutes: 90,
    timezone: 'America/New_York',
  };

  it('creates a practice for an entitled coach', async () => {
    mockPrisma.practiceSession.create.mockResolvedValue(practiceRow());

    const res = await request(app).post('/api/v1/practices').send(body);

    expect(res.status).toBe(201);
    expect(res.body.practice).toEqual(
      expect.objectContaining({ id: SESSION_ID, type: 'PRACTICE', team: { id: TEAM_ID, name: 'Lakers' } })
    );
    expect(mockPrisma.practiceSession.create.mock.calls[0][0].data.startsAt).toEqual(
      new Date('2030-01-15T23:00:00Z')
    );
  });

  it('answers 402 upgrade_required on the FREE tier, before any lookup', async () => {
    mockCaller = {};
    const res = await request(app).post('/api/v1/practices').send(body);
    expect(res.status).toBe(402);
    expect(res.body).toEqual(
      expect.objectContaining({ code: 'upgrade_required', feature: 'practice_scheduling', requiredTier: 'PREMIUM' })
    );
    expect(mockPrisma.practiceSession.create).not.toHaveBeenCalled();
  });

  it('answers 403 to an entitled caller without canManageTeam', async () => {
    (hasTeamPermission as jest.Mock).mockResolvedValue(false);
    const res = await request(app).post('/api/v1/practices').send(body);
    expect(res.status).toBe(403);
  });

  it('answers 400 for a floating local time and an unknown zone', async () => {
    const floating = await request(app).post('/api/v1/practices').send({ ...body, startsAt: '2030-01-15T18:00:00' });
    expect(floating.status).toBe(400);
    const zone = await request(app).post('/api/v1/practices').send({ ...body, timezone: 'Eastern' });
    expect(zone.status).toBe(400);
    expect(zone.body.error).toMatch(/IANA/);
    expect(mockPrisma.practiceSession.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/practices', () => {
  it('lists the caller’s practices with pagination at the top level', async () => {
    mockPrisma.practiceSession.count.mockResolvedValue(1);
    mockPrisma.practiceSession.findMany.mockResolvedValue([practiceRow()]);

    const res = await request(app).get(`/api/v1/practices?teamId=${TEAM_ID}&from=2030-01-01T00:00:00Z&limit=10`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ success: true, total: 1, limit: 10, offset: 0, practices: [expect.any(Object)] })
    );
  });

  it('answers 400 for a rejected query value without reading', async () => {
    const res = await request(app).get('/api/v1/practices?limit=500');
    expect(res.status).toBe(400);
    expect(mockPrisma.practiceSession.findMany).not.toHaveBeenCalled();
  });

  it('answers 403 for a team the caller cannot read', async () => {
    (canAccessTeam as jest.Mock).mockResolvedValue(false);
    const res = await request(app).get(`/api/v1/practices?teamId=${TEAM_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/practices/:id', () => {
  it('returns the practice with availability counts to a reader (a guardian included)', async () => {
    mockCaller = { role: 'PARENT' };
    mockPrisma.practiceSession.findUnique.mockResolvedValue(practiceRow());
    mockPrisma.practiceAvailability.groupBy.mockResolvedValue([{ status: 'NO', _count: { status: 2 } }]);

    const res = await request(app).get(`/api/v1/practices/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.practice.availabilitySummary).toEqual({ yes: 0, no: 2, maybe: 0 });
  });

  it('answers 400 for a malformed id, 404 for an unknown one, 403 without access', async () => {
    expect((await request(app).get('/api/v1/practices/nope')).status).toBe(400);

    mockPrisma.practiceSession.findUnique.mockResolvedValue(null);
    expect((await request(app).get(`/api/v1/practices/${SESSION_ID}`)).status).toBe(404);

    mockPrisma.practiceSession.findUnique.mockResolvedValue(practiceRow());
    (canAccessTeam as jest.Mock).mockResolvedValue(false);
    expect((await request(app).get(`/api/v1/practices/${SESSION_ID}`)).status).toBe(403);
  });
});

describe('PATCH /api/v1/practices/:id', () => {
  it('edits one occurrence of a series and marks it an exception (no entitlement needed)', async () => {
    mockCaller = {};
    mockPrisma.practiceSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      teamId: TEAM_ID,
      seriesId: SERIES_ID,
      status: 'SCHEDULED',
    });
    mockPrisma.practiceSession.update.mockResolvedValue(practiceRow({ seriesId: SERIES_ID, isException: true, location: 'Gym B' }));

    const res = await request(app).patch(`/api/v1/practices/${SESSION_ID}`).send({ location: 'Gym B' });

    expect(res.status).toBe(200);
    expect(res.body.practice.isException).toBe(true);
    expect(mockPrisma.practiceSession.update.mock.calls[0][0].data).toEqual({ location: 'Gym B', isException: true });
  });

  it('answers 400 for an empty body or a status change, and for a cancelled practice', async () => {
    expect((await request(app).patch(`/api/v1/practices/${SESSION_ID}`).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/v1/practices/${SESSION_ID}`).send({ status: 'CANCELLED' })).status).toBe(400);

    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION_ID, teamId: TEAM_ID, seriesId: null, status: 'CANCELLED' });
    const res = await request(app).patch(`/api/v1/practices/${SESSION_ID}`).send({ title: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A cancelled practice cannot be edited');
  });
});

describe('POST /api/v1/practices/:id/cancel and DELETE /api/v1/practices/:id', () => {
  beforeEach(() => {
    mockCaller = {};
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION_ID, teamId: TEAM_ID, seriesId: null, status: 'SCHEDULED' });
  });

  it('cancels with a reason, even without a body', async () => {
    mockPrisma.practiceSession.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.practiceSession.findUnique
      .mockResolvedValueOnce({ id: SESSION_ID, teamId: TEAM_ID, seriesId: null, status: 'SCHEDULED' })
      .mockResolvedValueOnce(practiceRow({ status: 'CANCELLED', cancelReason: 'Gym closed' }));

    const res = await request(app).post(`/api/v1/practices/${SESSION_ID}/cancel`).send({ reason: 'Gym closed' });
    expect(res.status).toBe(200);
    expect(res.body.practice.status).toBe('CANCELLED');

    mockPrisma.practiceSession.findUnique
      .mockResolvedValueOnce({ id: SESSION_ID, teamId: TEAM_ID, seriesId: null, status: 'CANCELLED' })
      .mockResolvedValueOnce(practiceRow({ status: 'CANCELLED' }));
    expect((await request(app).post(`/api/v1/practices/${SESSION_ID}/cancel`)).status).toBe(200);
  });

  it('deletes, and answers 403 to a non-manager', async () => {
    mockPrisma.practiceSession.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/v1/practices/${SESSION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Practice deleted successfully' });

    (hasTeamPermission as jest.Mock).mockResolvedValue(false);
    expect((await request(app).delete(`/api/v1/practices/${SESSION_ID}`)).status).toBe(403);
    expect((await request(app).post(`/api/v1/practices/${SESSION_ID}/cancel`)).status).toBe(403);
  });
});

describe('availability', () => {
  const userSummary = (id: string, email: string | null): Record<string, unknown> => ({
    id,
    name: 'Someone',
    isManaged: false,
    deletedAt: null,
    email,
  });

  beforeEach(() => {
    mockCaller = { role: 'PARENT' };
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION_ID, teamId: TEAM_ID, status: 'SCHEDULED' });
  });

  it('PUT lets a guardian answer for a child, keyed on the child, email projected away', async () => {
    (isGuardianOf as jest.Mock).mockResolvedValue(true);
    (hasTeamPermission as jest.Mock).mockResolvedValue(false);
    mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'm' });
    mockPrisma.practiceAvailability.upsert.mockResolvedValue({
      id: 'av',
      sessionId: SESSION_ID,
      userId: CHILD_ID,
      status: 'NO',
      comment: 'Away',
      createdAt: new Date(),
      updatedAt: new Date(),
      user: userSummary(CHILD_ID, 'kid@example.test'),
    });

    const res = await request(app)
      .put(`/api/v1/practices/${SESSION_ID}/availability`)
      .send({ status: 'NO', comment: 'Away', playerId: CHILD_ID });

    expect(res.status).toBe(200);
    expect(res.body.availability.userId).toBe(CHILD_ID);
    expect(res.body.availability.user.email).toBeUndefined();
  });

  it('PUT answers 400 for a bad status and for a cancelled practice', async () => {
    mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'm' });
    expect((await request(app).put(`/api/v1/practices/${SESSION_ID}/availability`).send({ status: 'LATE' })).status).toBe(400);
    mockPrisma.practiceSession.findUnique.mockResolvedValue({ id: SESSION_ID, teamId: TEAM_ID, status: 'CANCELLED' });
    expect((await request(app).put(`/api/v1/practices/${SESSION_ID}/availability`).send({ status: 'YES' })).status).toBe(400);
  });

  it('PUT answers 403 to anyone not on the roster', async () => {
    mockPrisma.teamMember.findUnique.mockResolvedValue(null);
    expect((await request(app).put(`/api/v1/practices/${SESSION_ID}/availability`).send({ status: 'YES' })).status).toBe(403);
  });

  it('GET returns every answer plus the summary', async () => {
    (hasTeamPermission as jest.Mock).mockResolvedValue(false);
    mockPrisma.practiceAvailability.findMany.mockResolvedValue([
      {
        id: 'av',
        sessionId: SESSION_ID,
        userId: CHILD_ID,
        status: 'YES',
        comment: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: userSummary(CHILD_ID, 'kid@example.test'),
      },
    ]);

    const res = await request(app).get(`/api/v1/practices/${SESSION_ID}/availability`);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ yes: 1, no: 0, maybe: 0 });
    expect(res.body.availability[0].user.email).toBeUndefined();
  });
});


/**
 * Freezes only `Date` (no timer is faked, so promises and supertest run
 * normally) at a day inside the fixtures' series window, so the 31-day
 * backdate rule does not turn these fixed DST dates stale as time passes.
 */
function freezeDate(iso: string): void {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
      'clearInterval', 'setTimeout', 'clearTimeout',
    ],
  });
}

describe('/api/v1/practice-series', () => {
  beforeEach(() => freezeDate('2026-10-25T12:00:00Z'));
  afterEach(() => jest.useRealTimers());

  const body = {
    teamId: TEAM_ID,
    location: 'Main gym',
    frequency: 'WEEKLY',
    weekdays: [2],
    startDate: '2026-10-20',
    startTime: '18:00',
    durationMinutes: 90,
    timezone: 'America/New_York',
    endDate: '2026-11-10',
  };
  const seriesRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: SERIES_ID,
    teamId: TEAM_ID,
    type: 'PRACTICE',
    frequency: 'WEEKLY',
    weekdays: [2],
    startDate: new Date('2026-10-20T00:00:00Z'),
    endDate: new Date('2026-11-10T00:00:00Z'),
    startTime: '18:00',
    timezone: 'America/New_York',
    cancelledAt: null,
    team: { id: TEAM_ID, name: 'Lakers' },
    sessions: [],
    ...overrides,
  });

  it('POST materializes the sessions across the DST change', async () => {
    mockPrisma.practiceSeries.create.mockResolvedValue({ id: SERIES_ID });
    mockPrisma.practiceSession.createMany.mockResolvedValue({ count: 4 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow());

    const res = await request(app).post('/api/v1/practice-series').send(body);

    expect(res.status).toBe(201);
    expect(res.body.series).toEqual(
      expect.objectContaining({ id: SERIES_ID, startDate: '2026-10-20', endDate: '2026-11-10' })
    );
    const sessions = mockPrisma.practiceSession.createMany.mock.calls[0][0].data as Array<{ startsAt: Date }>;
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-20T22:00:00.000Z',
      '2026-10-27T22:00:00.000Z',
      '2026-11-03T23:00:00.000Z',
      '2026-11-10T23:00:00.000Z',
    ]);
  });

  it('POST answers 402 on FREE, 400 for an invalid rule and for one that is too long', async () => {
    mockCaller = {};
    expect((await request(app).post('/api/v1/practice-series').send(body)).status).toBe(402);

    mockCaller = { ...PREMIUM };
    const both = await request(app).post('/api/v1/practice-series').send({ ...body, occurrenceCount: 3 });
    expect(both.status).toBe(400);
    expect(both.body.error).toMatch(/exactly one of endDate or occurrenceCount/);

    const tooMany = await request(app)
      .post('/api/v1/practice-series')
      .send({ ...body, weekdays: [0, 1, 2, 3, 4, 5, 6], endDate: '2027-10-20' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/more than 100 practices/);
    expect(mockPrisma.practiceSeries.create).not.toHaveBeenCalled();
  });

  it('GET returns the series to a reader', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    const res = await request(app).get(`/api/v1/practice-series/${SERIES_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.series.id).toBe(SERIES_ID);
  });

  it('PATCH edits the series going forward and reports how many sessions changed', async () => {
    mockCaller = {};
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mockPrisma.practiceSeries.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.practiceSession.updateMany.mockResolvedValue({ count: 3 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow({ location: 'Gym B' }));

    const res = await request(app).patch(`/api/v1/practice-series/${SERIES_ID}`).send({ location: 'Gym B' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, updatedSessions: 3 }));
    expect((await request(app).patch(`/api/v1/practice-series/${SERIES_ID}`).send({ startTime: '19:00' })).status).toBe(400);
  });

  it('DELETE cancels the series and reports the deleted future sessions', async () => {
    mockCaller = {};
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    mockPrisma.practiceSeries.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.practiceSession.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.practiceSeries.findUniqueOrThrow.mockResolvedValue(seriesRow({ cancelledAt: new Date() }));

    const res = await request(app).delete(`/api/v1/practice-series/${SERIES_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, deletedSessions: 2 }));
    expect(res.body.series.cancelledAt).not.toBeNull();
  });

  it('DELETE answers 404 for an unknown series and 403 to a non-manager', async () => {
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(null);
    expect((await request(app).delete(`/api/v1/practice-series/${SERIES_ID}`)).status).toBe(404);
    mockPrisma.practiceSeries.findUnique.mockResolvedValue(seriesRow());
    (hasTeamPermission as jest.Mock).mockResolvedValue(false);
    expect((await request(app).delete(`/api/v1/practice-series/${SERIES_ID}`)).status).toBe(403);
  });
});
