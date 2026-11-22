/**
 * Team join links (#210) through the real route → schema → JoinLinkService →
 * shared Prisma mock path. Only authentication is stubbed.
 *
 * Covers the roster-manager gate on every team-scoped route, that the token
 * reaches a response only inside the manager's `link.url`, the public preview
 * (team name and state, nothing else; a revoked link is a 404), the join
 * request (self and child, idempotent, already a member, expired, full,
 * revoked, the pending cap) and the decisions (approve writes the roster,
 * decline writes nothing, a decided request is a 400).
 *
 * What Postgres does with the conditional use-count UPDATE, the locks and
 * account deletion is proven in `tests/integration/join-link.db.test.ts`.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { NotificationService } from '../../src/services/notification-service';
import { joinRequestRateLimit } from '../../src/api/middleware/rate-limit';
import { JOIN_REQUEST_TTL_DAYS, MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT } from '../../src/services/join-link-service';
import { logger } from '../../src/utils/logger';
import { domainEvent, spyOnInfo } from '../support/domain-events';
import { mockPrisma } from '../setup';

const COACH_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const PARENT_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEAM_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const LINK_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';
const REQUEST_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const CHILD_ID = 'a7b8c9d0-e1f2-4456-a890-bcdef0123456';
const SECRET_TOKEN = 'joinSecretToken_0123456789abcdefghijklmnopq';
const DAY_MS = 24 * 60 * 60 * 1000;

let mockCaller: { id: string; email: string; role: 'COACH' | 'PLAYER' | 'PARENT' } = {
  id: COACH_ID,
  email: 'coach@example.com',
  role: 'COACH',
};

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    const { authUser } = jest.requireActual('../support/auth-fixtures');
    req.user = authUser({ id: mockCaller.id, email: mockCaller.email, role: mockCaller.role });
    next();
  }),
}));

/** Prisma `select` semantics on a plain object: keep `true` keys, recurse into `{ select }`. */
function applySelect(row: Record<string, unknown>, select?: Record<string, unknown>): Record<string, unknown> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) {
      out[key] = row[key];
    } else if (spec && typeof spec === 'object' && 'select' in spec) {
      out[key] = applySelect(row[key] as Record<string, unknown>, (spec as { select: Record<string, unknown> }).select);
    }
  }
  return out;
}

/** A full `TeamJoinLink` row as Prisma stores it, secret included. */
function linkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    id: LINK_ID,
    teamId: TEAM_ID,
    token: SECRET_TOKEN,
    createdById: COACH_ID,
    expiresAt: new Date(now + 14 * DAY_MS),
    maxUses: null,
    useCount: 0,
    revokedAt: null,
    createdAt: new Date(now - DAY_MS),
    updatedAt: new Date(now - DAY_MS),
    team: { name: 'Hornets' },
    ...overrides,
  };
}

/** A full `TeamJoinRequest` row with its requester. */
function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    teamId: TEAM_ID,
    linkId: LINK_ID,
    requesterId: PARENT_ID,
    kind: 'SELF',
    childName: null,
    relationship: null,
    status: 'PENDING',
    decidedAt: null,
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(Date.now() - 60_000),
    requester: { id: PARENT_ID, name: 'Pat Parent', email: 'pat@example.com', isManaged: false, deletedAt: null },
    ...overrides,
  };
}

function expectNoToken(body: unknown): void {
  const json = JSON.stringify(body);
  expect(json).not.toContain(SECRET_TOKEN);
  expect(json).not.toContain('"token"');
}

/**
 * The team exists; the caller holds a staff row whose role has
 * `canManageRoster` (or no row at all, which is every other signed-in user).
 */
function givenTeam(options: { callerManagesRoster?: boolean } = {}): void {
  const { callerManagesRoster = true } = options;
  mockPrisma.user.findUnique.mockResolvedValue({ role: mockCaller.role });
  mockPrisma.team.findUnique.mockResolvedValue({
    id: TEAM_ID,
    name: 'Hornets',
    season: { league: { admins: [] } },
  });
  mockPrisma.teamStaff.findUnique.mockResolvedValue(
    callerManagesRoster
      ? {
          role: {
            type: 'ASSISTANT_COACH',
            canManageTeam: false,
            canManageRoster: true,
            canTrackStats: true,
            canViewStats: true,
            canShareStats: false,
          },
        }
      : null
  );
  mockPrisma.teamMember.findUnique.mockResolvedValue(null);
  mockPrisma.guardian.findFirst.mockResolvedValue(null);
}

function asParent(): void {
  mockCaller = { id: PARENT_ID, email: 'pat@example.com', role: 'PLAYER' };
}

describe('Team join links API (#210)', () => {
  let pushSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCaller = { id: COACH_ID, email: 'coach@example.com', role: 'COACH' };
    for (const fn of [
      mockPrisma.user.findUnique,
      mockPrisma.user.findFirst,
      mockPrisma.user.create,
      mockPrisma.user.updateMany,
      mockPrisma.team.findUnique,
      mockPrisma.teamStaff.findUnique,
      mockPrisma.teamStaff.findMany,
      mockPrisma.teamStaff.count,
      mockPrisma.teamMember.findUnique,
      mockPrisma.teamMember.create,
      mockPrisma.teamMember.upsert,
      mockPrisma.teamMember.count,
      mockPrisma.guardian.findFirst,
      mockPrisma.guardian.findMany,
      mockPrisma.guardian.create,
      mockPrisma.teamJoinLink.findUnique,
      mockPrisma.teamJoinLink.findFirst,
      mockPrisma.teamJoinLink.create,
      mockPrisma.teamJoinLink.updateMany,
      mockPrisma.teamJoinRequest.findFirst,
      mockPrisma.teamJoinRequest.findUniqueOrThrow,
      mockPrisma.teamJoinRequest.findMany,
      mockPrisma.teamJoinRequest.create,
      mockPrisma.teamJoinRequest.updateMany,
      mockPrisma.$queryRaw,
      mockPrisma.$executeRaw,
    ]) {
      fn.mockReset();
    }
    // lockUsers / lockTeamRow: every row asked for exists and is live.
    mockPrisma.$queryRaw.mockImplementation(async () => [
      { id: COACH_ID, deletedAt: null },
      { id: PARENT_ID, deletedAt: null },
    ]);
    // The conditional use-count UPDATE takes a use unless a test says otherwise.
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.teamJoinLink.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.teamJoinLink.create.mockImplementation(
      async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) =>
        applySelect(linkRow({ ...data, createdAt: new Date() }), select)
    );
    mockPrisma.teamJoinRequest.findMany.mockResolvedValue([]);
    // A decision's status-guarded update matches the row; the lazy expiry of
    // stale requests finds none, unless a test says otherwise.
    mockPrisma.teamJoinRequest.updateMany.mockImplementation(
      async ({ data }: { data: { status: string } }) => ({ count: data.status === 'EXPIRED' ? 0 : 1 })
    );
    // The requester (and, on approval, the account behind the request) is a live login.
    mockPrisma.user.findFirst.mockResolvedValue({ id: PARENT_ID, role: 'PLAYER' });
    mockPrisma.teamJoinRequest.create.mockImplementation(
      async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) =>
        applySelect(requestRow({ ...data, createdAt: new Date() }), select)
    );
    mockPrisma.guardian.findMany.mockResolvedValue([]);
    mockPrisma.teamStaff.findMany.mockResolvedValue([{ userId: COACH_ID }]);
    pushSpy = jest.spyOn(NotificationService, 'sendToUsers').mockResolvedValue([]);
  });

  afterEach(() => {
    pushSpy.mockRestore();
  });

  describe('POST /teams/:teamId/join-link', () => {
    const url = `/api/v1/teams/${TEAM_ID}/join-link`;

    it('creates the link with the default 14-day life and no cap, and returns the URL to share', async () => {
      givenTeam();
      const info = spyOnInfo();
      const before = Date.now();

      const res = await request(app).post(url).send({});

      expect(res.status).toBe(201);
      const data = mockPrisma.teamJoinLink.create.mock.calls[0][0].data as {
        token: string;
        expiresAt: Date;
        maxUses: number | null;
        createdById: string;
      };
      // 32 random bytes, base64url.
      expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(data.maxUses).toBeNull();
      expect(data.createdById).toBe(COACH_ID);
      const life = data.expiresAt.getTime() - before;
      expect(life).toBeGreaterThanOrEqual(14 * DAY_MS - 1000);
      expect(life).toBeLessThanOrEqual(14 * DAY_MS + 5000);
      expect(res.body.link).toMatchObject({ id: LINK_ID, teamId: TEAM_ID, maxUses: null, useCount: 0 });
      expect(res.body.link.url).toMatch(new RegExp(`/join/${data.token}$`));
      expect(res.body.link).not.toHaveProperty('token');
      // The domain event carries ids and settings only, never the token.
      expect(domainEvent(info, 'Join link created')).toEqual({
        linkId: LINK_ID,
        teamId: TEAM_ID,
        userId: COACH_ID,
        expiresInDays: 14,
        maxUses: null,
        revokedCount: 0,
      });
      expect(JSON.stringify(info.mock.calls)).not.toContain(data.token);
    });

    it('rotates: the live link is revoked in the same transaction as the create', async () => {
      givenTeam();
      mockPrisma.teamJoinLink.updateMany.mockResolvedValue({ count: 1 });

      const res = await request(app).post(url).send({ expiresInDays: 3, maxUses: 20 });

      expect(res.status).toBe(201);
      expect(mockPrisma.teamJoinLink.updateMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockPrisma.teamJoinLink.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.teamJoinLink.create.mock.invocationCallOrder[0]
      );
      expect(mockPrisma.teamJoinLink.create.mock.calls[0][0].data.maxUses).toBe(20);
      expect(res.body.link.maxUses).toBe(20);
    });

    it('refuses a caller who cannot manage the roster with 403 and writes nothing', async () => {
      givenTeam({ callerManagesRoster: false });

      const res = await request(app).post(url).send({});

      expect(res.status).toBe(403);
      expect(mockPrisma.teamJoinLink.create).not.toHaveBeenCalled();
      expect(mockPrisma.teamJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown team and 400 for an invalid body or team id', async () => {
      mockPrisma.team.findUnique.mockResolvedValue(null);
      expect((await request(app).post(url).send({})).status).toBe(404);

      givenTeam();
      const invalid = await request(app).post(url).send({ expiresInDays: 365 });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain('expiresInDays must be at most 30');
      expect((await request(app).post('/api/v1/teams/not-a-uuid/join-link').send({})).status).toBe(400);
      expect(mockPrisma.teamJoinLink.create).not.toHaveBeenCalled();
    });

    it('answers 404 when the creator or the team is gone under the lock', async () => {
      givenTeam();
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: COACH_ID, deletedAt: new Date() }]);
      expect((await request(app).post(url).send({})).status).toBe(404);

      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: COACH_ID, deletedAt: null }]).mockResolvedValueOnce([]);
      expect((await request(app).post(url).send({})).status).toBe(404);
      expect(mockPrisma.teamJoinLink.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /teams/:teamId/join-link', () => {
    const url = `/api/v1/teams/${TEAM_ID}/join-link`;

    it('returns the live link to a roster manager, the token only inside the URL', async () => {
      givenTeam();
      mockPrisma.teamJoinLink.findFirst.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(linkRow({ useCount: 4 }), select)
      );

      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      expect(res.body.link).toMatchObject({ id: LINK_ID, useCount: 4 });
      expect(res.body.link.url).toMatch(new RegExp(`/join/${SECRET_TOKEN}$`));
      expect(res.body.link).not.toHaveProperty('token');
      expect(mockPrisma.teamJoinLink.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: TEAM_ID, revokedAt: null, expiresAt: { gt: expect.any(Date) } },
        })
      );
    });

    it('returns link: null when the team has no live link', async () => {
      givenTeam();
      mockPrisma.teamJoinLink.findFirst.mockResolvedValue(null);

      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, link: null });
    });

    it('never shows the link to a member or guardian: 403 without reading it', async () => {
      givenTeam({ callerManagesRoster: false });
      // A rostered player: read access to the team, no roster management.
      mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'member-row' });

      const res = await request(app).get(url);

      expect(res.status).toBe(403);
      expect(mockPrisma.teamJoinLink.findFirst).not.toHaveBeenCalled();
      expectNoToken(res.body);
    });
  });

  describe('POST /teams/:teamId/join-link/revoke', () => {
    const url = `/api/v1/teams/${TEAM_ID}/join-link/revoke`;

    it('revokes every live link and logs the event', async () => {
      givenTeam();
      mockPrisma.teamJoinLink.updateMany.mockResolvedValue({ count: 1 });
      const info = spyOnInfo();

      const res = await request(app).post(url);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, revoked: 1 });
      expect(mockPrisma.teamJoinLink.updateMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // Behind the team row lock a concurrent create holds.
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.teamJoinLink.updateMany.mock.invocationCallOrder[0]
      );
      expect(domainEvent(info, 'Join link revoked')).toEqual({ teamId: TEAM_ID, userId: COACH_ID, revokedCount: 1 });
    });

    it('answers 404 when the team is gone under the lock', async () => {
      givenTeam();
      mockPrisma.$queryRaw.mockResolvedValueOnce([]);
      expect((await request(app).post(url)).status).toBe(404);
      expect(mockPrisma.teamJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a caller who cannot manage the roster', async () => {
      givenTeam({ callerManagesRoster: false });
      expect((await request(app).post(url)).status).toBe(403);
      expect(mockPrisma.teamJoinLink.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('GET /join/:token (public preview)', () => {
    const url = `/api/v1/join/${SECRET_TOKEN}`;

    it('exposes the team name and the state only, and logs the view without the token', async () => {
      mockPrisma.teamJoinLink.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(linkRow({ useCount: 7 }), select)
      );
      const info = spyOnInfo();

      const res = await request(app).get(url).set('X-Hooplings-Client', 'web');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, link: { teamName: 'Hornets', state: 'active' } });
      expect(domainEvent(info, 'Join link viewed')).toEqual({ linkId: LINK_ID, state: 'active', client: 'web' });
      expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET_TOKEN);
      // The lookup selects no roster, no coach and no token.
      const select = mockPrisma.teamJoinLink.findUnique.mock.calls[0][0].select as Record<string, unknown>;
      expect(Object.keys(select).sort()).toEqual(
        ['expiresAt', 'id', 'maxUses', 'revokedAt', 'team', 'teamId', 'useCount'].sort()
      );
      expect(select.team).toEqual({ select: { name: true } });
    });

    it.each([
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['full', { maxUses: 5, useCount: 5 }],
    ])('reports a link that is %s', async (state, overrides) => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow(overrides));

      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      expect(res.body.link).toEqual({ teamName: 'Hornets', state });
    });

    it('answers the same 404 for a revoked link as for an unknown one', async () => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow({ revokedAt: new Date() }));
      const revoked = await request(app).get(url);
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(null);
      const unknown = await request(app).get(url);

      expect(revoked.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(revoked.body).toEqual(unknown.body);
      expect(revoked.body).toEqual({ error: 'Join link not found' });
    });

    // The web page renders server-side from one egress IP, so the preview is
    // exempt from the global 100/min IP limit (skipGlobalApiLimit).
    it('is not gated by the global IP limit', async () => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow());

      for (let i = 0; i < 120; i += 1) {
        const res = await request(app).get(`/api/v1/join/ssr-egress-${i}-abcdefgh`);
        expect(res.status).toBe(200);
      }
    });

    it('rejects a malformed token before any lookup', async () => {
      const res = await request(app).get('/api/v1/join/short');
      expect(res.status).toBe(400);
      expect(mockPrisma.teamJoinLink.findUnique).not.toHaveBeenCalled();
    });

    it('answers 500 with the fallback body when the lookup fails', async () => {
      mockPrisma.teamJoinLink.findUnique.mockRejectedValue(new Error('db down'));
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);

      const res = await request(app).get(url);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch join link' });
      errorSpy.mockRestore();
    });
  });

  describe('POST /join/:token (ask to join)', () => {
    const url = `/api/v1/join/${SECRET_TOKEN}`;

    beforeEach(async () => {
      asParent();
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow());
      mockPrisma.teamMember.findUnique.mockResolvedValue(null);
      // The per-account budget (20 an hour) is exhausted on purpose in the
      // last test of this block; every other test starts with a full one.
      await joinRequestRateLimit.resetKey(`join-request-user:${PARENT_ID}`);
    });

    it('creates a pending SELF request, takes one use, writes nothing to the roster and tells the coaches', async () => {
      const info = spyOnInfo();

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        success: true,
        status: 'pending',
        created: true,
        teamName: 'Hornets',
        request: { id: REQUEST_ID, kind: 'SELF', status: 'PENDING' },
      });
      // A link holder learns the team's name, never its id or anything on it.
      expect(res.body).not.toHaveProperty('teamId');
      expectNoToken(res.body);
      expect(mockPrisma.teamJoinRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            teamId: TEAM_ID,
            linkId: LINK_ID,
            requesterId: PARENT_ID,
            kind: 'SELF',
            childName: null,
            relationship: null,
          },
        })
      );
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.teamMember.create).not.toHaveBeenCalled();
      expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(domainEvent(info, 'Join request created')).toEqual({
        requestId: REQUEST_ID,
        teamId: TEAM_ID,
        linkId: LINK_ID,
        requesterId: PARENT_ID,
        kind: 'SELF',
      });
      // The push names the team, never the requester or a child.
      expect(mockPrisma.teamStaff.findMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, role: { canManageRoster: true }, userId: { not: PARENT_ID } },
        select: { userId: true },
      });
      expect(pushSpy).toHaveBeenCalledWith([COACH_ID], {
        title: 'New join request',
        body: 'Someone asked to join Hornets. Review the request in the app.',
        data: { type: 'join_request', teamId: TEAM_ID },
      });
    });

    it('creates a pending CHILD request with the name and relationship, and no roster record yet', async () => {
      const info = spyOnInfo();

      const res = await request(app)
        .post(url)
        .send({ kind: 'child', childName: '  Riley Park ', relationship: 'MOTHER', childEmail: 'r@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.request).toMatchObject({ kind: 'CHILD', status: 'PENDING' });
      expect(mockPrisma.teamJoinRequest.create.mock.calls[0][0].data).toEqual({
        teamId: TEAM_ID,
        linkId: LINK_ID,
        requesterId: PARENT_ID,
        kind: 'CHILD',
        childName: 'Riley Park',
        relationship: 'MOTHER',
      });
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.guardian.create).not.toHaveBeenCalled();
      // No name in any log line.
      expect(JSON.stringify(info.mock.calls)).not.toContain('Riley');
    });

    it('is a no-op for an account already on the roster', async () => {
      mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'member-row' });

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, status: 'already_member', teamId: TEAM_ID, teamName: 'Hornets' });
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('is a no-op for a child the account already guards on the team (name compared loosely)', async () => {
      mockPrisma.guardian.findMany.mockResolvedValue([{ child: { name: 'Riley  Park', deletedAt: null } }]);

      const res = await request(app).post(url).send({ kind: 'child', childName: 'riley park', relationship: 'FATHER' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('already_member');
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('returns the request already waiting instead of creating a second one (double tap)', async () => {
      mockPrisma.teamJoinRequest.findMany.mockResolvedValue([
        { id: REQUEST_ID, kind: 'SELF', status: 'PENDING', createdAt: new Date(), childName: null },
      ]);

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'pending', created: false, request: { id: REQUEST_ID } });
      expect(res.body.request).not.toHaveProperty('childName');
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('treats a second child (another name) as a new request and the same child as the existing one', async () => {
      mockPrisma.teamJoinRequest.findMany.mockResolvedValue([
        { id: REQUEST_ID, kind: 'CHILD', status: 'PENDING', createdAt: new Date(), childName: 'Riley Park' },
      ]);

      const same = await request(app).post(url).send({ kind: 'child', childName: 'RILEY PARK', relationship: 'MOTHER' });
      expect(same.status).toBe(200);
      expect(same.body.created).toBe(false);

      const sibling = await request(app).post(url).send({ kind: 'child', childName: 'Jordan Park', relationship: 'MOTHER' });
      expect(sibling.status).toBe(201);
      expect(mockPrisma.teamJoinRequest.create).toHaveBeenCalledTimes(1);
    });

    it('caps the requests one account may have waiting on a team', async () => {
      mockPrisma.teamJoinRequest.findMany.mockResolvedValue(
        Array.from({ length: MAX_PENDING_JOIN_REQUESTS_PER_ACCOUNT }, (_, i) => ({
          id: `req-${i}`,
          kind: 'CHILD',
          status: 'PENDING',
          createdAt: new Date(),
          childName: `Child ${i}`,
        }))
      );

      const res = await request(app).post(url).send({ kind: 'child', childName: 'One More', relationship: 'OTHER' });

      expect(res.status).toBe(400);
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['full', { maxUses: 3, useCount: 3 }],
    ])('refuses a link that is %s with 410 join_link_inactive', async (reason, overrides) => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow(overrides));

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ code: 'join_link_inactive', reason });
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
    });

    it('refuses a revoked or unknown link with the same 404', async () => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow({ revokedAt: new Date() }));
      const revoked = await request(app).post(url).send({ kind: 'self' });
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(null);
      const unknown = await request(app).post(url).send({ kind: 'self' });

      expect(revoked.status).toBe(404);
      expect(unknown.body).toEqual(revoked.body);
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
    });

    it('refuses when the last use was taken between the read and the write (410 full)', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(0);
      mockPrisma.teamJoinLink.findUnique
        .mockResolvedValueOnce(linkRow({ maxUses: 3, useCount: 2 }))
        .mockResolvedValueOnce(linkRow({ maxUses: 3, useCount: 3 }));

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ code: 'join_link_inactive', reason: 'full' });
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
    });

    it('refuses when the link was revoked between the read and the write (404)', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(0);
      mockPrisma.teamJoinLink.findUnique
        .mockResolvedValueOnce(linkRow())
        .mockResolvedValueOnce(linkRow({ revokedAt: new Date() }));

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(404);
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
    });

    it('refuses an account that is deleted, or un-claimed into a managed record, under the lock', async () => {
      // The read after the lock asks for a live login and finds none.
      mockPrisma.user.findFirst.mockResolvedValue(null);

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(404);
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: PARENT_ID, deletedAt: null, isManaged: false },
        select: { id: true },
      });
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['full', { maxUses: 1, useCount: 1 }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['revoked (rotated)', { revokedAt: new Date() }],
    ])('a retry still finds the request already waiting when the link is now %s', async (_label, overrides) => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow(overrides));
      mockPrisma.teamJoinRequest.findMany.mockResolvedValue([
        { id: REQUEST_ID, kind: 'SELF', status: 'PENDING', createdAt: new Date(), childName: null },
      ]);

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'pending', created: false, request: { id: REQUEST_ID } });
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('a member re-opening a link that has since died is still told they are on the team', async () => {
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow({ revokedAt: new Date() }));
      mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'member-row' });

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('already_member');
    });

    it('lapses the requester\'s stale requests before counting them, and logs how many', async () => {
      mockPrisma.teamJoinRequest.updateMany.mockResolvedValue({ count: 2 });
      const info = spyOnInfo();
      const before = Date.now();

      const res = await request(app).post(url).send({ kind: 'self' });

      expect(res.status).toBe(201);
      const call = mockPrisma.teamJoinRequest.updateMany.mock.calls[0][0] as {
        where: { teamId: string; requesterId: string; status: string; createdAt: { lt: Date } };
        data: Record<string, unknown>;
      };
      expect(call.where).toMatchObject({ teamId: TEAM_ID, requesterId: PARENT_ID, status: 'PENDING' });
      const cutoff = before - JOIN_REQUEST_TTL_DAYS * DAY_MS;
      expect(Math.abs(call.where.createdAt.lt.getTime() - cutoff)).toBeLessThan(5000);
      // The typed name goes with the lapse.
      expect(call.data).toEqual({ status: 'EXPIRED', decidedAt: expect.any(Date), childName: null });
      expect(mockPrisma.teamJoinRequest.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.teamJoinRequest.findMany.mock.invocationCallOrder[0]
      );
      expect(domainEvent(info, 'Join requests expired')).toEqual({ teamId: TEAM_ID, expiredCount: 2 });
    });

    it('rejects an invalid body and a malformed token with 400', async () => {
      const noKind = await request(app).post(url).send({});
      expect(noKind.status).toBe(400);
      expect(noKind.body.error).toContain('kind must be self or child');
      const noName = await request(app).post(url).send({ kind: 'child', relationship: 'MOTHER' });
      expect(noName.status).toBe(400);
      expect((await request(app).post('/api/v1/join/short').send({ kind: 'self' })).status).toBe(400);
      expect(mockPrisma.teamJoinRequest.create).not.toHaveBeenCalled();
    });

    it('still answers 201 when the push to the coaches fails, or when the team has no roster manager', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      pushSpy.mockRejectedValue(new Error('expo down'));
      const failed = await request(app).post(url).send({ kind: 'self' });
      expect(failed.status).toBe(201);
      expect(warnSpy).toHaveBeenCalledWith('Join request push failed', { teamId: TEAM_ID, error: 'expo down' });

      pushSpy.mockClear();
      mockPrisma.teamStaff.findMany.mockResolvedValue([]);
      const nobody = await request(app).post(url).send({ kind: 'self' });
      expect(nobody.status).toBe(201);
      expect(pushSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('POST /join/:token rate limit', () => {
    it('stops one account at 20 join requests an hour, whatever the IP', async () => {
      asParent();
      await joinRequestRateLimit.resetKey(`join-request-user:${PARENT_ID}`);
      mockPrisma.teamJoinLink.findUnique.mockResolvedValue(linkRow());
      mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'member-row' });

      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        const res = await request(app).post(`/api/v1/join/${SECRET_TOKEN}`).send({ kind: 'self' });
        statuses.push(res.status);
      }

      expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
      expect(statuses[20]).toBe(429);
      await joinRequestRateLimit.resetKey(`join-request-user:${PARENT_ID}`);
    });
  });

  describe('GET /teams/:teamId/join-requests', () => {
    const url = `/api/v1/teams/${TEAM_ID}/join-requests`;

    it('lists pending requests with the requester for a roster manager', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findMany.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => [
          applySelect(requestRow({ kind: 'CHILD', childName: 'Riley Park', relationship: 'MOTHER' }), select),
        ]
      );

      const res = await request(app).get(url);

      expect(res.status).toBe(200);
      expect(res.body.requests).toEqual([
        expect.objectContaining({
          id: REQUEST_ID,
          kind: 'CHILD',
          childName: 'Riley Park',
          relationship: 'MOTHER',
          status: 'PENDING',
          requester: { id: PARENT_ID, name: 'Pat Parent', email: 'pat@example.com', isManaged: false, deletedAt: null },
        }),
      ]);
      expect(mockPrisma.teamJoinRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: TEAM_ID, status: 'PENDING' }, orderBy: { createdAt: 'asc' } })
      );
      // Requests nobody decided in time lapse before the list is read.
      expect(mockPrisma.teamJoinRequest.updateMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, status: 'PENDING', createdAt: { lt: expect.any(Date) } },
        data: { status: 'EXPIRED', decidedAt: expect.any(Date), childName: null },
      });
    });

    it('refuses everyone else with 403 without reading the requests', async () => {
      givenTeam({ callerManagesRoster: false });
      mockPrisma.teamMember.findUnique.mockResolvedValue({ id: 'member-row' });

      const res = await request(app).get(url);

      expect(res.status).toBe(403);
      expect(mockPrisma.teamJoinRequest.findMany).not.toHaveBeenCalled();
    });
  });

  describe('POST /teams/:teamId/join-requests/:requestId/approve', () => {
    const url = `/api/v1/teams/${TEAM_ID}/join-requests/${REQUEST_ID}/approve`;

    beforeEach(() => {
      mockPrisma.teamJoinRequest.findUniqueOrThrow.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(requestRow({ status: 'ACCEPTED' }), select)
      );
    });

    it('SELF: adds the requester to the roster (create-if-missing) and tells them', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow());
      mockPrisma.teamMember.upsert.mockResolvedValue({ id: 'member-row' });
      const info = spyOnInfo();

      const res = await request(app).post(url);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        playerId: PARENT_ID,
        request: { id: REQUEST_ID, kind: 'SELF', status: 'ACCEPTED' },
      });
      expect(mockPrisma.teamJoinRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: REQUEST_ID, teamId: TEAM_ID } })
      );
      // Guarded on PENDING, and the name is cleared with the decision.
      expect(mockPrisma.teamJoinRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: 'PENDING' },
        data: { status: 'ACCEPTED', decidedAt: expect.any(Date), childName: null },
      });
      expect(mockPrisma.teamMember.upsert).toHaveBeenCalledWith({
        where: { teamId_playerId: { teamId: TEAM_ID, playerId: PARENT_ID } },
        create: { teamId: TEAM_ID, playerId: PARENT_ID },
        update: {},
        select: { id: true },
      });
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.guardian.create).not.toHaveBeenCalled();
      expect(domainEvent(info, 'Join request approved')).toEqual({
        requestId: REQUEST_ID,
        teamId: TEAM_ID,
        requesterId: PARENT_ID,
        playerId: PARENT_ID,
        kind: 'SELF',
        userId: COACH_ID,
      });
      expect(pushSpy).toHaveBeenCalledWith([PARENT_ID], {
        title: 'Request approved',
        body: 'You have been added to Hornets.',
        data: { type: 'join_request_approved', teamId: TEAM_ID },
      });
    });

    it('CHILD: creates a managed roster record, its membership and the guardian link, and makes a bare PLAYER a PARENT', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(
        requestRow({ kind: 'CHILD', childName: 'Riley Park', relationship: 'MOTHER' })
      );
      mockPrisma.user.create.mockResolvedValue({ id: CHILD_ID });
      mockPrisma.teamMember.create.mockResolvedValue({ id: 'member-row' });
      mockPrisma.guardian.create.mockResolvedValue({ id: 'guardian-row' });
      mockPrisma.teamMember.count.mockResolvedValue(0);
      mockPrisma.teamStaff.count.mockResolvedValue(0);
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
      const info = spyOnInfo();

      const res = await request(app).post(url);

      expect(res.status).toBe(200);
      expect(res.body.playerId).toBe(CHILD_ID);
      // A roster record, never a login: managed, no email, the approver manages it.
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: { name: 'Riley Park', role: 'PLAYER', isManaged: true, managedById: COACH_ID, email: null },
        select: { id: true },
      });
      expect(mockPrisma.teamMember.create).toHaveBeenCalledWith({
        data: { teamId: TEAM_ID, playerId: CHILD_ID },
        select: { id: true },
      });
      expect(mockPrisma.guardian.create).toHaveBeenCalledWith({
        data: { parentId: PARENT_ID, childId: CHILD_ID, relationship: 'MOTHER', isPrimary: true },
        select: { id: true },
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: PARENT_ID, deletedAt: null },
        data: { role: 'PARENT' },
      });
      expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(JSON.stringify(info.mock.calls)).not.toContain('Riley');
      // The parent is told about the child, not that they joined; still no name.
      expect(pushSpy).toHaveBeenCalledWith([PARENT_ID], {
        title: 'Request approved',
        body: 'Your child has been added to Hornets.',
        data: { type: 'join_request_approved', teamId: TEAM_ID },
      });
    });

    it('refuses a request that lapsed but was not flipped yet', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(
        requestRow({ createdAt: new Date(Date.now() - (JOIN_REQUEST_TTL_DAYS + 1) * DAY_MS) })
      );

      const res = await request(app).post(url);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Cannot approve a join request with status: EXPIRED');
      expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
    });

    it('CHILD: a coach who is also a parent keeps the COACH role', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(
        requestRow({ kind: 'CHILD', childName: 'Riley Park', relationship: 'FATHER' })
      );
      mockPrisma.user.create.mockResolvedValue({ id: CHILD_ID });
      mockPrisma.user.findFirst.mockResolvedValue({ role: 'COACH' });

      const res = await request(app).post(url);

      expect(res.status).toBe(200);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an incomplete CHILD row instead of creating a nameless record', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow({ kind: 'CHILD', childName: null }));

      const res = await request(app).post(url);

      expect(res.status).toBe(400);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('answers 400 for a request already decided, before and behind the lock', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow({ status: 'REJECTED' }));
      const decided = await request(app).post(url);
      expect(decided.status).toBe(400);
      expect(decided.body.error).toBe('Cannot approve a join request with status: REJECTED');

      // Two coaches approve at once: the loser's guarded update matches nothing.
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow());
      mockPrisma.teamJoinRequest.updateMany.mockResolvedValue({ count: 0 });
      const raced = await request(app).post(url);
      expect(raced.status).toBe(400);
      expect(raced.body.error).toBe('Cannot approve join request: it is no longer pending');
      expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('answers 404 for another team\'s request id and 403 for a caller who cannot manage the roster', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(null);
      expect((await request(app).post(url)).status).toBe(404);

      givenTeam({ callerManagesRoster: false });
      const forbidden = await request(app).post(url);
      expect(forbidden.status).toBe(403);
      expect(mockPrisma.teamJoinRequest.updateMany).not.toHaveBeenCalled();
    });

    it('refuses when the requester is no longer a login, or the approver was deleted, meanwhile', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow());
      // Deleted, or un-claimed into a managed record: the read after the lock finds no live login.
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      const requesterGone = await request(app).post(url);
      expect(requesterGone.status).toBe(400);
      expect(requesterGone.body.error).toBe('The account that sent this request no longer exists');
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: PARENT_ID, deletedAt: null, isManaged: false },
        select: { role: true },
      });

      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: PARENT_ID, deletedAt: null }]);
      const approverGone = await request(app).post(url);
      expect(approverGone.status).toBe(404);
      expect(mockPrisma.teamJoinRequest.updateMany).not.toHaveBeenCalled();
    });

    it('still answers 200 when the push to the requester fails', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow());
      mockPrisma.teamMember.upsert.mockResolvedValue({ id: 'member-row' });
      pushSpy.mockRejectedValue('offline');
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      const res = await request(app).post(url);

      expect(res.status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith('Join approval push failed', { teamId: TEAM_ID, error: 'offline' });
      warnSpy.mockRestore();
    });
  });

  describe('POST /teams/:teamId/join-requests/:requestId/decline', () => {
    const url = `/api/v1/teams/${TEAM_ID}/join-requests/${REQUEST_ID}/decline`;

    it('declines a pending request, clears the name and writes nothing to the roster', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(
        requestRow({ kind: 'CHILD', childName: 'Riley Park', relationship: 'MOTHER' })
      );
      mockPrisma.teamJoinRequest.findUniqueOrThrow.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(requestRow({ kind: 'CHILD', status: 'REJECTED' }), select)
      );
      const info = spyOnInfo();

      const res = await request(app).post(url);

      expect(res.status).toBe(200);
      expect(res.body.request).toMatchObject({ id: REQUEST_ID, status: 'REJECTED' });
      expect(res.body.request).not.toHaveProperty('childName');
      expect(mockPrisma.teamJoinRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: 'PENDING' },
        data: { status: 'REJECTED', decidedAt: expect.any(Date), childName: null },
      });
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(domainEvent(info, 'Join request declined')).toEqual({
        requestId: REQUEST_ID,
        teamId: TEAM_ID,
        requesterId: PARENT_ID,
        userId: COACH_ID,
      });
    });

    it('answers 400 when the request was decided meanwhile and 403 for a non-manager', async () => {
      givenTeam();
      mockPrisma.teamJoinRequest.findFirst.mockResolvedValue(requestRow());
      mockPrisma.teamJoinRequest.updateMany.mockResolvedValue({ count: 0 });
      const raced = await request(app).post(url);
      expect(raced.status).toBe(400);
      expect(raced.body.error).toBe('Cannot decline join request: it is no longer pending');

      givenTeam({ callerManagesRoster: false });
      expect((await request(app).post(url)).status).toBe(403);
    });
  });
});
