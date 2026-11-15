/**
 * Staff invitations by email (#460) through the real route → schema →
 * StaffInvitationService → shared Prisma mock path. Only authentication and
 * the usage cache are stubbed; the mailer is the test FakeMailer, spied on.
 *
 * Covers the create gate (`canManageStaff`: head coach yes, assistant 403),
 * that invite time creates no `User` row (the claim-by-email hazard), the
 * dedupe / supersede / cooldown / partial-index answers, the per-send
 * `emailSent` flag, the team list and cancel, and the three accept paths:
 * authenticated by id, public by token (account created, existing account,
 * unclaimed managed record refused 409 `sign_in_required`), and the decline
 * that strips the address. The token never appears on any response.
 *
 * What Postgres does with the partial index, `emailEquals` and the locks is
 * proven in `tests/integration/staff-invitation.db.test.ts`.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { mailer } from '../../src/services/mailer';
import { invalidateUsage } from '../../src/services/usage-service';
import { hashRecipient } from '../../src/utils/hash-recipient';
import { uniqueViolation } from '../factories';
import { mockPrisma } from '../setup';

const HEAD_COACH_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const ASSISTANT_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const INVITEE_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const TEAM_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const OTHER_TEAM_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';
const INVITATION_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const ROLE_ID = 'a7b8c9d0-e1f2-4456-a890-bcdef0123456';
const STAFF_ROW_ID = 'b8c9d0e1-f2a3-4567-a901-cdef01234567';
const LEAGUE_ID = 'c9d0e1f2-a3b4-4678-a012-def012345678';
const INVITEE_EMAIL = 'new.coach@example.com';
const SECRET_TOKEN = 'staffSecretToken_0123456789abcdefghijklmnopq';
const DAY_MS = 24 * 60 * 60 * 1000;

let mockCaller: { id: string; email: string } = { id: HEAD_COACH_ID, email: 'head@example.com' };

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    const { authUser } = jest.requireActual('../support/auth-fixtures');
    req.user = authUser({ id: mockCaller.id, email: mockCaller.email });
    next();
  }),
}));

jest.mock('../../src/services/usage-service', () => ({
  canCreateTeam: jest.fn().mockResolvedValue(true),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  workosUserId: string | null;
  isManaged: boolean;
  deletedAt: Date | null;
}

const USERS: Record<string, UserRow> = {
  [HEAD_COACH_ID]: { id: HEAD_COACH_ID, name: 'Casey Head', email: 'head@example.com', role: 'COACH', workosUserId: 'wk-head', isManaged: false, deletedAt: null },
  [ASSISTANT_ID]: { id: ASSISTANT_ID, name: 'Alex Assistant', email: 'assistant@example.com', role: 'COACH', workosUserId: 'wk-asst', isManaged: false, deletedAt: null },
  [INVITEE_ID]: { id: INVITEE_ID, name: 'Nia New', email: INVITEE_EMAIL, role: 'PLAYER', workosUserId: 'wk-new', isManaged: false, deletedAt: null },
};

/** A full `StaffInvitation` row as Prisma stores it, secret included. */
function invitationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id: INVITATION_ID,
    token: SECRET_TOKEN,
    teamId: TEAM_ID,
    invitedEmail: INVITEE_EMAIL,
    recipientHash: hashRecipient(INVITEE_EMAIL),
    roleType: 'ASSISTANT_COACH',
    invitedById: HEAD_COACH_ID,
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 7 * DAY_MS),
    createdAt: new Date(now.getTime() - DAY_MS),
    updatedAt: now,
    acceptedAt: null,
    rejectedAt: null,
    team: { name: 'Hornets' },
    invitedBy: { id: HEAD_COACH_ID, name: 'Casey Head', deletedAt: null },
    ...overrides,
  };
}

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

function staffRow(userId: string, roleType = 'ASSISTANT_COACH'): Record<string, unknown> {
  return {
    id: STAFF_ROW_ID,
    teamId: TEAM_ID,
    userId,
    roleId: ROLE_ID,
    user: { id: userId, name: USERS[userId]?.name ?? 'new.coach', email: INVITEE_EMAIL },
    role: { id: ROLE_ID, teamId: TEAM_ID, type: roleType, name: 'Assistant Coach' },
  };
}

function expectNoSecret(body: unknown): void {
  const json = JSON.stringify(body);
  expect(json).not.toContain(SECRET_TOKEN);
  expect(json).not.toContain('"token"');
  expect(json).not.toContain('recipientHash');
}

/** The caller is the team's head coach (canManageStaff via the HEAD_COACH staff row). */
function givenTeam(options: { callerIsHeadCoach?: boolean } = {}): void {
  const { callerIsHeadCoach = true } = options;
  mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM_ID, name: 'Hornets', lineageId: 'lineage-1', season: { leagueId: LEAGUE_ID } });
  // latestTeamSeasonId: this team-season is its lineage's latest.
  mockPrisma.team.findFirst.mockResolvedValue({ id: TEAM_ID });
  mockPrisma.leagueAdmin.findUnique.mockResolvedValue(null);
  mockPrisma.teamStaff.findFirst.mockResolvedValue(callerIsHeadCoach ? { id: 'head-row' } : null);
  mockPrisma.teamRole.findFirst.mockImplementation(async ({ where }: { where: { type: string } }) => ({
    id: ROLE_ID,
    teamId: TEAM_ID,
    type: where.type,
    name: where.type === 'HEAD_COACH' ? 'Head Coach' : where.type === 'TEAM_MANAGER' ? 'Team Manager' : 'Assistant Coach',
  }));
}

describe('staff invitations (#460) through the real StaffInvitationService', () => {
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCaller = { id: HEAD_COACH_ID, email: 'head@example.com' };
    for (const fn of [
      mockPrisma.staffInvitation.findUnique,
      mockPrisma.staffInvitation.findFirst,
      mockPrisma.staffInvitation.findMany,
      mockPrisma.staffInvitation.findUniqueOrThrow,
      mockPrisma.staffInvitation.create,
      mockPrisma.staffInvitation.update,
      mockPrisma.staffInvitation.updateMany,
      mockPrisma.user.findFirst,
      mockPrisma.user.create,
      mockPrisma.teamStaff.findUnique,
      mockPrisma.teamStaff.create,
      mockPrisma.$queryRaw,
      mockPrisma.$executeRaw,
    ]) {
      fn.mockReset();
    }
    mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.teamInvitation.findUnique.mockResolvedValue(null);
    mockPrisma.guardianInvitation.findUnique.mockResolvedValue(null);
    mockPrisma.guardianInvitation.findMany.mockResolvedValue([]);
    mockPrisma.staffInvitation.findFirst.mockResolvedValue(null);
    mockPrisma.staffInvitation.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.staffInvitation.create.mockImplementation(
      async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) =>
        applySelect(invitationRow({ ...data, createdAt: new Date() }), select)
    );
    // lockTeamRow / lockUsers: every row asked for exists and is live.
    mockPrisma.$queryRaw.mockImplementation(async () => [{ id: 'locked', deletedAt: null }]);
    mockPrisma.$executeRaw.mockResolvedValue(0);
    // The inviter's row is live unless a test says otherwise.
    mockPrisma.user.count.mockResolvedValue(1);
    sendSpy = jest.spyOn(mailer, 'send').mockResolvedValue({ messageId: 'm-1' });
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  describe('POST /teams/:teamId/staff-invitations', () => {
    const url = `/api/v1/teams/${TEAM_ID}/staff-invitations`;

    it('invites an address with no account: no User row, lower-cased address, email sent, no token', async () => {
      givenTeam();

      const res = await request(app).post(url).send({ email: '  New.Coach@Example.com ', roleType: 'ASSISTANT_COACH' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        success: true,
        emailSent: true,
        invitation: { teamId: TEAM_ID, invitedEmail: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH', status: 'PENDING' },
      });
      expectNoSecret(res.body);
      // The consent rule: nothing is pre-provisioned that syncUser could claim.
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.staffInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invitedEmail: INVITEE_EMAIL,
            recipientHash: hashRecipient(INVITEE_EMAIL),
            roleType: 'ASSISTANT_COACH',
            invitedById: HEAD_COACH_ID,
            status: 'PENDING',
          }),
          select: expect.not.objectContaining({ token: expect.anything() }),
        })
      );
      const createdToken = mockPrisma.staffInvitation.create.mock.calls[0][0].data.token as string;
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: INVITEE_EMAIL,
          variables: expect.objectContaining({
            teamName: 'Hornets',
            roleName: 'Assistant Coach',
            inviterName: 'Casey Head',
            acceptUrl: expect.stringMatching(new RegExp(`/invite/${createdToken}$`)),
          }),
        })
      );
      // Lazy expiry only: without supersede the live row is never expired.
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ teamId: TEAM_ID, status: 'PENDING', expiresAt: { lte: expect.any(Date) } }),
        data: { status: 'EXPIRED' },
      });
    });

    it('reports a failed send as emailSent: false, never a 5xx', async () => {
      givenTeam();
      sendSpy.mockRejectedValue(new Error('SES down'));

      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'TEAM_MANAGER' });

      expect(res.status).toBe(201);
      expect(res.body.emailSent).toBe(false);
      expect(res.body.invitation.roleType).toBe('TEAM_MANAGER');
    });

    it.each([
      [{ email: 'not-an-email', roleType: 'ASSISTANT_COACH' }, 'Invalid email format'],
      [{ email: INVITEE_EMAIL, roleType: 'CUSTOM' }, 'roleType must be one of'],
      [{ email: INVITEE_EMAIL }, 'roleType must be one of'],
      [{ roleType: 'HEAD_COACH' }, ''],
    ])('answers 400 for %j before touching the service', async (body, message) => {
      givenTeam();
      const res = await request(app).post(url).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(message);
      expect(mockPrisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('is refused 403 to an assistant coach (canManageStaff, not a roster or read predicate)', async () => {
      mockCaller = { id: ASSISTANT_ID, email: 'assistant@example.com' };
      givenTeam({ callerIsHeadCoach: false });

      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH' });

      expect(res.status).toBe(403);
      expect(mockPrisma.staffInvitation.create).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown team', async () => {
      givenTeam();
      mockPrisma.team.findUnique.mockResolvedValue(null);
      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH' });
      expect(res.status).toBe(404);
    });

    it('answers 400 when the address already belongs to a staff member of the team', async () => {
      givenTeam();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID });
      mockPrisma.teamStaff.findUnique.mockResolvedValue({ id: STAFF_ROW_ID });

      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'HEAD_COACH' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This person is already a staff member of this team');
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) })
      );
      expect(mockPrisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('answers 400 for a live PENDING invitation without supersede', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst.mockResolvedValueOnce({ id: INVITATION_ID });

      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A pending staff invitation already exists for this email');
      expect(mockPrisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('supersedes the live row (old link dies) and creates a fresh one with the new role', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst
        .mockResolvedValueOnce({ id: INVITATION_ID })
        .mockResolvedValueOnce({ createdAt: new Date(Date.now() - 10 * 60 * 1000) });
      mockPrisma.staffInvitation.updateMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .post(url)
        .send({ email: INVITEE_EMAIL, roleType: 'HEAD_COACH', supersede: true });

      expect(res.status).toBe(201);
      expect(res.body.invitation.roleType).toBe('HEAD_COACH');
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { teamId: TEAM_ID, invitedEmail: expect.anything(), status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      expectNoSecret(res.body);
    });

    it('answers 429 resend_cooldown when the newest row for the address is inside the window', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst
        .mockResolvedValueOnce({ id: INVITATION_ID })
        .mockResolvedValueOnce({ createdAt: new Date(Date.now() - 30 * 1000) });

      const res = await request(app)
        .post(url)
        .send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH', supersede: true });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('resend_cooldown');
      expect(mockPrisma.staffInvitation.findFirst).toHaveBeenLastCalledWith({
        where: { teamId: TEAM_ID, recipientHash: hashRecipient(INVITEE_EMAIL) },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('maps a lost race on the partial PENDING index to the dedupe 400, never 500', async () => {
      givenTeam();
      mockPrisma.staffInvitation.create.mockRejectedValue(
        uniqueViolation('StaffInvitation_pending_teamId_invitedEmail_key')
      );

      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A pending staff invitation already exists for this email');
    });

    it('lets a token collision (another unique) propagate as a 500', async () => {
      givenTeam();
      mockPrisma.staffInvitation.create.mockRejectedValue(uniqueViolation('StaffInvitation_token_key'));

      const res = await request(app).post(url).send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH' });

      expect(res.status).toBe(500);
    });
  });

  describe('GET and DELETE /teams/:teamId/staff-invitations', () => {
    it('lists pending, unexpired rows to a head coach without the token', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findMany.mockImplementation(async ({ select }: { select: Record<string, unknown> }) => [
        applySelect(invitationRow(), select),
      ]);

      const res = await request(app).get(`/api/v1/teams/${TEAM_ID}/staff-invitations`);

      expect(res.status).toBe(200);
      expect(res.body.invitations).toEqual([
        expect.objectContaining({
          id: INVITATION_ID,
          invitedEmail: INVITEE_EMAIL,
          roleType: 'ASSISTANT_COACH',
          invitedBy: { id: HEAD_COACH_ID, name: 'Casey Head', deletedAt: null },
        }),
      ]);
      expect(mockPrisma.staffInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: TEAM_ID, status: 'PENDING', expiresAt: { gt: expect.any(Date) } },
        })
      );
      expectNoSecret(res.body);
    });

    it('refuses the list to a caller who may not manage staff (403)', async () => {
      mockCaller = { id: ASSISTANT_ID, email: 'assistant@example.com' };
      givenTeam({ callerIsHeadCoach: false });
      const res = await request(app).get(`/api/v1/teams/${TEAM_ID}/staff-invitations`);
      expect(res.status).toBe(403);
      expect(mockPrisma.staffInvitation.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 to the list for an unknown team', async () => {
      givenTeam();
      mockPrisma.team.findUnique.mockResolvedValue(null);
      const res = await request(app).get(`/api/v1/teams/${TEAM_ID}/staff-invitations`);
      expect(res.status).toBe(404);
    });

    it('cancels a PENDING row with a status-guarded update and keeps the address', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst.mockResolvedValue({ id: INVITATION_ID, status: 'PENDING' });
      mockPrisma.staffInvitation.update.mockImplementation(
        async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) =>
          applySelect(invitationRow(data), select)
      );

      const res = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff-invitations/${INVITATION_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation).toMatchObject({ status: 'CANCELLED', invitedEmail: INVITEE_EMAIL });
      expect(mockPrisma.staffInvitation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: INVITATION_ID, teamId: TEAM_ID } })
      );
      expect(mockPrisma.staffInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INVITATION_ID, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        })
      );
      expectNoSecret(res.body);
    });

    it('answers 404 for an invitation of another team, 403 for a non-manager, 400 once not pending', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst.mockResolvedValueOnce(null);
      const other = await request(app).delete(`/api/v1/teams/${OTHER_TEAM_ID}/staff-invitations/${INVITATION_ID}`);
      expect(other.status).toBe(404);

      mockPrisma.staffInvitation.findFirst.mockResolvedValue({ id: INVITATION_ID, status: 'ACCEPTED' });
      const accepted = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff-invitations/${INVITATION_ID}`);
      expect(accepted.status).toBe(400);

      mockCaller = { id: ASSISTANT_ID, email: 'assistant@example.com' };
      givenTeam({ callerIsHeadCoach: false });
      mockPrisma.staffInvitation.findFirst.mockResolvedValue({ id: INVITATION_ID, status: 'PENDING' });
      const forbidden = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff-invitations/${INVITATION_ID}`);
      expect(forbidden.status).toBe(403);
      expect(mockPrisma.staffInvitation.update).not.toHaveBeenCalled();
    });

    it('a non-manager gets 403 whether or not the invitation id exists on the team', async () => {
      mockCaller = { id: ASSISTANT_ID, email: 'assistant@example.com' };
      givenTeam({ callerIsHeadCoach: false });
      const res = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff-invitations/${INVITATION_ID}`);
      expect(res.status).toBe(403);
      expect(mockPrisma.staffInvitation.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a new invitation on a team-season that is not its lineage\'s latest', async () => {
      givenTeam();
      mockPrisma.team.findFirst.mockResolvedValue({ id: OTHER_TEAM_ID });
      const res = await request(app)
        .post(`/api/v1/teams/${TEAM_ID}/staff-invitations`)
        .send({ email: INVITEE_EMAIL, roleType: 'ASSISTANT_COACH' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('past season');
      expect(mockPrisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('a plain invite right after a cancel or decline is held by the cooldown too', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst
        .mockResolvedValueOnce(null) // no live PENDING row (it was cancelled)
        .mockResolvedValueOnce({ createdAt: new Date(Date.now() - 20 * 1000) });
      const res = await request(app)
        .post(`/api/v1/teams/${TEAM_ID}/staff-invitations`)
        .send({ email: INVITEE_EMAIL, roleType: 'HEAD_COACH' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('resend_cooldown');
      expect(mockPrisma.staffInvitation.create).not.toHaveBeenCalled();
    });

    it('answers 400 when a concurrent accept wins the cancel (P2025 on the guarded update)', async () => {
      givenTeam();
      mockPrisma.staffInvitation.findFirst.mockResolvedValue({ id: INVITATION_ID, status: 'PENDING' });
      const { Prisma } = jest.requireActual('@prisma/client');
      mockPrisma.staffInvitation.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: 'test' })
      );
      const res = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff-invitations/${INVITATION_ID}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Cannot cancel invitation: it is no longer pending');
    });
  });

  describe('the invitee: GET /invitations, accept and reject by id', () => {
    beforeEach(() => {
      mockCaller = { id: INVITEE_ID, email: INVITEE_EMAIL };
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(invitationRow(), select)
      );
    });

    it('GET /invitations carries staffInvitations addressed to the caller, without token or address', async () => {
      mockPrisma.teamInvitation.findMany.mockResolvedValue([]);
      mockPrisma.teamInvitation.count.mockResolvedValue(0);
      mockPrisma.staffInvitation.findMany.mockImplementation(async ({ select }: { select: Record<string, unknown> }) => [
        applySelect(invitationRow(), select),
      ]);

      const res = await request(app).get('/api/v1/invitations');

      expect(res.status).toBe(200);
      expect(res.body.staffInvitations).toEqual([
        {
          kind: 'staff',
          id: INVITATION_ID,
          status: 'PENDING',
          teamName: 'Hornets',
          roleType: 'ASSISTANT_COACH',
          inviterName: 'Casey Head',
          inviterDeletedAt: null,
          expiresAt: expect.any(String),
        },
      ]);
      expect(mockPrisma.staffInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            invitedEmail: { equals: INVITEE_EMAIL, mode: 'insensitive' },
            status: 'PENDING',
            expiresAt: { gt: expect.any(Date) },
          },
        })
      );
      expectNoSecret(res.body);
    });

    it('GET /invitations scoped to a team or player carries no staffInvitations', async () => {
      mockPrisma.teamInvitation.findMany.mockResolvedValue([]);
      mockPrisma.teamInvitation.count.mockResolvedValue(0);
      mockCaller = { id: HEAD_COACH_ID, email: 'head@example.com' };
      givenTeam();
      const res = await request(app).get(`/api/v1/invitations?teamId=${TEAM_ID}`);
      expect(res.body.staffInvitations).toEqual([]);
      expect(mockPrisma.staffInvitation.findMany).not.toHaveBeenCalled();
    });

    it('accept by id puts the verified caller on staff with the invited role (no lookup by address)', async () => {
      mockPrisma.teamStaff.findUnique.mockResolvedValue(null);
      givenTeam();
      mockPrisma.teamStaff.create.mockResolvedValue(staffRow(INVITEE_ID));
      mockPrisma.staffInvitation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.staffInvitation.findUniqueOrThrow.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ status: 'ACCEPTED', acceptedAt: new Date() }), select)
      );

      const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        kind: 'staff',
        alreadyStaff: false,
        invitation: { id: INVITATION_ID, status: 'ACCEPTED' },
        staff: { teamId: TEAM_ID, userId: INVITEE_ID, role: { type: 'ASSISTANT_COACH' } },
      });
      expectNoSecret(res.body);
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, status: 'PENDING' },
        data: { status: 'ACCEPTED', acceptedAt: expect.any(Date) },
      });
      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { teamId: TEAM_ID, userId: INVITEE_ID, roleId: ROLE_ID } })
      );
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(invalidateUsage).toHaveBeenCalledWith(INVITEE_ID);
    });

    it('accept keeps an existing staff row untouched (never re-roles, so never demotes a head coach)', async () => {
      givenTeam();
      mockPrisma.teamStaff.findUnique.mockResolvedValue(staffRow(INVITEE_ID, 'HEAD_COACH'));
      mockPrisma.staffInvitation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.staffInvitation.findUniqueOrThrow.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ status: 'ACCEPTED' }), select)
      );

      const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ alreadyStaff: true, staff: { role: { type: 'HEAD_COACH' } } });
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
      expect(mockPrisma.teamStaff.update).not.toHaveBeenCalled();
    });

    it('answers 403 to a caller the invitation was not sent to, and writes nothing', async () => {
      mockCaller = { id: ASSISTANT_ID, email: 'assistant@example.com' };

      const accept = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);
      const reject = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/reject`);

      expect(accept.status).toBe(403);
      expect(reject.status).toBe(403);
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.staffInvitation.update).not.toHaveBeenCalled();
    });

    it('an expired invitation is flipped to EXPIRED on contact and refused 400', async () => {
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ expiresAt: new Date(Date.now() - 1000) }), select)
      );

      const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This invitation has expired');
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it.each([
      ['ACCEPTED', 'This invitation has already been accepted'],
      ['CANCELLED', 'Cannot accept invitation with status: CANCELLED'],
    ])('a %s invitation is refused 400', async (status, message) => {
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(invitationRow({ status }), select)
      );
      const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(message);
    });

    it('the loser of a concurrent accept gets 400, and a tombstoned account 404', async () => {
      givenTeam();
      mockPrisma.staffInvitation.updateMany.mockResolvedValue({ count: 0 });
      const lost = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);
      expect(lost.status).toBe(400);
      expect(lost.body.error).toBe('Cannot accept invitation: it is no longer pending');

      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: INVITEE_ID, deletedAt: new Date() }]);
      const gone = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);
      expect(gone.status).toBe(404);

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ id: INVITEE_ID, deletedAt: null }])
        .mockResolvedValueOnce([]);
      const noTeam = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);
      expect(noTeam.status).toBe(404);
      expect(noTeam.body.error).toBe('Team not found');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('reject strips the address (rejection-only strip) with a status-guarded update', async () => {
      mockPrisma.staffInvitation.update.mockImplementation(
        async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) =>
          applySelect(invitationRow(data), select)
      );

      const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/reject`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'staff', invitation: { status: 'REJECTED' } });
      expect(mockPrisma.staffInvitation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INVITATION_ID, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            rejectedAt: expect.any(Date),
            invitedEmail: `deleted-${INVITATION_ID}@invalid`,
          },
        })
      );
      expect(JSON.stringify(res.body)).not.toContain(INVITEE_EMAIL);
      expectNoSecret(res.body);
    });

    it('a declined (address-stripped) row reads as no invitation: 404 for anyone, never a misleading 403', async () => {
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(
            invitationRow({ status: 'REJECTED', invitedEmail: `deleted-${INVITATION_ID}@invalid` }),
            select
          )
      );
      const reject = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/reject`);
      const accept = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);
      expect(reject.status).toBe(404);
      expect(accept.status).toBe(404);
      expect(mockPrisma.staffInvitation.update).not.toHaveBeenCalled();
    });

    it('reject of a row that is no longer PENDING answers 400', async () => {
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ status: 'ACCEPTED' }), select)
      );
      const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/reject`);
      expect(res.status).toBe(400);
      expect(mockPrisma.staffInvitation.update).not.toHaveBeenCalled();
    });
  });

  describe('public by-token routes', () => {
    beforeEach(() => {
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(invitationRow(), select)
      );
    });

    it('GET /invitations/by-token/:token falls through team and guardian to the staff view', async () => {
      const res = await request(app).get(`/api/v1/invitations/by-token/${SECRET_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation).toEqual({
        kind: 'staff',
        id: INVITATION_ID,
        status: 'PENDING',
        teamName: 'Hornets',
        roleType: 'ASSISTANT_COACH',
        inviterName: 'Casey Head',
        inviterDeletedAt: null,
        expiresAt: expect.any(String),
      });
      // The public view carries no address and no secret.
      expect(JSON.stringify(res.body)).not.toContain(INVITEE_EMAIL);
      expectNoSecret(res.body);
    });

    it('GET answers 404 when no kind has the token', async () => {
      mockPrisma.staffInvitation.findUnique.mockResolvedValue(null);
      const res = await request(app).get(`/api/v1/invitations/by-token/${SECRET_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Invitation not found');
    });

    function givenAcceptable(): void {
      givenTeam();
      // By token, the address's account is one nobody has signed in to yet
      // (a claimed account must accept signed in).
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === INVITEE_ID ? { ...USERS[INVITEE_ID], workosUserId: null } : USERS[where.id] ?? null
      );
      // The row is still on the team it was read with.
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) => applySelect(invitationRow(), select)
      );
      mockPrisma.teamStaff.findUnique.mockResolvedValue(null);
      mockPrisma.staffInvitation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.staffInvitation.findUniqueOrThrow.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ status: 'ACCEPTED' }), select)
      );
      mockPrisma.teamStaff.create.mockImplementation(async ({ data }: { data: { userId: string } }) =>
        staffRow(data.userId)
      );
    }

    /** The `$executeRaw` calls whose SQL inserts a User row. */
    function userInserts(): unknown[][] {
      return mockPrisma.$executeRaw.mock.calls.filter((call: unknown[]) =>
        (call[0] as TemplateStringsArray).join('?').includes('INSERT INTO "User"')
      );
    }

    it('the public accept returns the invitation status only: no address, no inviter id', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(200);
      expect(res.body.invitation).toEqual({ id: INVITATION_ID, status: 'ACCEPTED' });
      expect(JSON.stringify(res.body)).not.toContain(INVITEE_EMAIL);
      expect(JSON.stringify(res.body)).not.toContain(HEAD_COACH_ID);
      expect(JSON.stringify(res.body)).not.toContain(INVITEE_ID);
    });

    it('re-reads the managed flag after the row lock: an adoption that committed first is refused 409', async () => {
      givenAcceptable();
      // Unlocked read: not managed. Read under the lock: Add Player adopted it meanwhile.
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: null, isManaged: false });
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === INVITEE_ID ? { ...USERS[INVITEE_ID], workosUserId: null, isManaged: true } : USERS[where.id] ?? null
      );

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('sign_in_required');
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('a team that lost the invited role answers 400, not "invitation not found"', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      mockPrisma.teamRole.findFirst.mockResolvedValue(null);

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This team no longer has the role this invitation was for');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('accept with no account creates it inside the transaction (lower-cased, unverified, COACH) and the staff row', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: INVITEE_ID, workosUserId: null, isManaged: false });
      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(200);
      // The unauthenticated answer names the team and role only, never the account.
      expect(res.body).toMatchObject({ kind: 'staff', alreadyStaff: false });
      expect(res.body.staff).toEqual({ teamId: TEAM_ID, roleType: 'ASSISTANT_COACH' });
      const inserts = userInserts();
      expect(inserts).toHaveLength(1);
      const sql = (inserts[0][0] as TemplateStringsArray).join('?');
      expect(sql).toContain('ON CONFLICT ("email") DO NOTHING');
      // Values: id, name (local part), email, role.
      expect(inserts[0].slice(2, 5)).toEqual(['new.coach', INVITEE_EMAIL, 'COACH']);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: INVITEE_EMAIL, mode: 'insensitive' }, deletedAt: null },
        })
      );
      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { teamId: TEAM_ID, userId: INVITEE_ID, roleId: ROLE_ID } })
      );
      expect(invalidateUsage).toHaveBeenCalledWith(INVITEE_ID);
      expectNoSecret(res.body);
    });

    it('a team manager invitation creates a PLAYER account (the app asks the role step)', async () => {
      givenAcceptable();
      mockPrisma.staffInvitation.findUnique.mockImplementation(
        async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ roleType: 'TEAM_MANAGER' }), select)
      );
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: INVITEE_ID, workosUserId: null, isManaged: false });

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(200);
      expect(userInserts()[0][4]).toBe('PLAYER');
    });

    it('accept lands on an unclaimed, unmanaged account that holds the address', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: null, isManaged: false });

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(200);
      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: INVITEE_ID }) })
      );
      expect(userInserts()).toHaveLength(0);
    });

    it('a claimed account must accept signed in: the public link answers 409 sign_in_required', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null);

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('sign_in_required');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('a row a rollover moved after the unlocked read is accepted on the new team-season, never cancelled', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: null, isManaged: false });
      // Read with the old team; under the lock it already sits on OTHER_TEAM_ID, the lineage's latest.
      mockPrisma.staffInvitation.findUnique
        .mockImplementationOnce(async ({ select }: { select: Record<string, unknown> }) => applySelect(invitationRow(), select))
        .mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
          applySelect(invitationRow({ teamId: OTHER_TEAM_ID }), select)
        );
      mockPrisma.team.findFirst.mockResolvedValue({ id: OTHER_TEAM_ID });

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(200);
      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ teamId: OTHER_TEAM_ID }) })
      );
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } })
      );
    });

    it('refuses 409 sign_in_required on an unclaimed managed roster record, writing nothing', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: null, isManaged: true });
      // The check reads the row under the transaction's lock.
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === INVITEE_ID ? { ...USERS[INVITEE_ID], workosUserId: null, isManaged: true } : USERS[where.id] ?? null
      );

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('sign_in_required');
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('a concurrent account create (insert did nothing) uses the winner, still refusing a managed one', async () => {
      givenAcceptable();
      mockPrisma.$executeRaw.mockResolvedValue(0);
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: INVITEE_ID, workosUserId: null, isManaged: false });

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);
      expect(res.status).toBe(200);
      expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: INVITEE_ID }) })
      );

      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: INVITEE_ID, workosUserId: null, isManaged: true });
      mockPrisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === INVITEE_ID ? { ...USERS[INVITEE_ID], workosUserId: null, isManaged: true } : USERS[where.id] ?? null
      );
      const managed = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);
      expect(managed.status).toBe(409);

      mockPrisma.user.findFirst.mockResolvedValue(null);
      const vanished = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);
      expect(vanished.status).toBe(500);
    });

    it('refuses 400 when the inviter can no longer manage the team staff (removed, demoted, deleted)', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      // canManageStaff(inviter): not admin, not league admin, no HEAD_COACH row any more.
      mockPrisma.teamStaff.findFirst.mockResolvedValue(null);

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('the coach who sent it can no longer manage');
      expect(mockPrisma.teamStaff.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: TEAM_ID, userId: HEAD_COACH_ID, role: { type: 'HEAD_COACH' } } })
      );
      // Never accepted; the dead invitation is cancelled after the rollback.
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) })
      );
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, status: 'PENDING', teamId: TEAM_ID },
        data: { status: 'CANCELLED' },
      });
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
    });

    it('refuses 400 when the inviter account was deleted, even a deleted system ADMIN', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      mockPrisma.user.count.mockResolvedValue(0);

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(mockPrisma.user.count).toHaveBeenCalledWith({ where: { id: HEAD_COACH_ID, deletedAt: null } });
      // Never accepted; the dead invitation is cancelled after the rollback.
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) })
      );
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, status: 'PENDING', teamId: TEAM_ID },
        data: { status: 'CANCELLED' },
      });
    });

    it('refuses 400 and cancels an invitation whose team-season is no longer the lineage\'s latest', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      mockPrisma.team.findFirst.mockResolvedValue({ id: OTHER_TEAM_ID }); // rolled over since

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('past season');
      expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
      // Never accepted; the dead invitation is cancelled after the rollback.
      expect(mockPrisma.staffInvitation.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) })
      );
      expect(mockPrisma.staffInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: INVITATION_ID, status: 'PENDING', teamId: TEAM_ID },
        data: { status: 'CANCELLED' },
      });
    });

    it('a coaching role promotes a bare PLAYER account to COACH; a team manager role does not', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: INVITEE_ID, role: { in: ['PLAYER', 'PARENT'] }, deletedAt: null },
        data: { role: 'COACH' },
      });

      // The role follows the staff row that exists: a team manager row (a new
      // one, or an existing one kept by alreadyStaff) promotes nothing.
      mockPrisma.user.updateMany.mockClear();
      mockPrisma.teamStaff.findUnique.mockResolvedValue(staffRow(INVITEE_ID, 'TEAM_MANAGER'));
      await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('maps a P2002 on the staff unique (a concurrent direct add) to 400, never 500', async () => {
      givenAcceptable();
      mockPrisma.user.findFirst.mockResolvedValue({ id: INVITEE_ID, workosUserId: 'wk-new', isManaged: false });
      mockPrisma.teamStaff.create.mockRejectedValue(uniqueViolation('TeamStaff_teamId_userId_key'));

      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('This person is already a staff member of this team');
    });

    it('accept answers 404 when no kind has the token', async () => {
      mockPrisma.staffInvitation.findUnique.mockResolvedValue(null);
      const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);
      expect(res.status).toBe(404);
    });
  });
});
