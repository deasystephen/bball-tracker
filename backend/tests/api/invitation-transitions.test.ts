/**
 * Invitation status transitions through the real route → InvitationService →
 * shared Prisma mock path (#766): accept, reject, cancel and the public
 * by-token accept. Only authentication is stubbed.
 *
 * The token is kept out of every response twice: the service reads the row
 * back through an `INVITATION_*_SELECT` without `token`, and each route wraps
 * the invitation in `omitToken`. `teamInvitation.findUniqueOrThrow` applies
 * the `select` the service passes to a full row that carries a `token`, the
 * way Prisma does, so the main cases prove the select; the last block makes
 * the read-back leak the token and proves `omitToken` on its own. The public
 * lookup (`GET /invitations/by-token/:token`) builds its payload field by
 * field, so its leak is staged one layer up, in the service's return value.
 */

import request from 'supertest';
import { app } from '../../src/index';
import { InvitationService, type PublicInvitation } from '../../src/services/invitation-service';
import { GuardianService, type PublicGuardianInvitation } from '../../src/services/guardian-service';
import { NotFoundError } from '../../src/utils/errors';
import { mockPrisma } from '../setup';

const PLAYER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const COACH_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const TEAM_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const INVITATION_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const MEMBER_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';
const SECRET_TOKEN = 'secret-invitation-token-0123456789';

let mockCaller: { id: string; role: string } = { id: PLAYER_ID, role: 'PLAYER' };

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    const { authUser } = jest.requireActual('../support/auth-fixtures');
    req.user = authUser({ id: mockCaller.id, role: mockCaller.role, email: null });
    next();
  }),
}));

/** A full `TeamInvitation` row as Prisma stores it, secret included. */
function invitationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id: INVITATION_ID,
    teamId: TEAM_ID,
    playerId: PLAYER_ID,
    invitedById: COACH_ID,
    status: 'PENDING',
    token: SECRET_TOKEN,
    jerseyNumber: 0,
    position: 'PG',
    message: null,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    rejectedAt: null,
    team: { id: TEAM_ID, name: 'Lakers' },
    ...overrides,
  };
}

/** Prisma `select` semantics on a plain object: keep `true` keys, recurse into `{ select }`. */
function applySelect(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
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

/** The row after the transition `updateMany` wrote `data`, read back with the service's select. */
function readBackAfter(data: () => Record<string, unknown>): void {
  mockPrisma.teamInvitation.findUniqueOrThrow.mockImplementation(
    async ({ select }: { select: Record<string, unknown> }) => applySelect(invitationRow(data()), select)
  );
}

function expectNoToken(body: unknown): void {
  expect((body as { invitation: object }).invitation).not.toHaveProperty('token');
  expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);
}

function expectGuardedTransition(status: string): void {
  expect(mockPrisma.teamInvitation.updateMany).toHaveBeenCalledWith({
    where: { id: INVITATION_ID, status: 'PENDING' },
    data: expect.objectContaining({ status }),
  });
  expect(mockPrisma.teamInvitation.findUniqueOrThrow).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: INVITATION_ID },
      select: expect.not.objectContaining({ token: expect.anything() }),
    })
  );
}

const expectedMemberWhere = { teamId_playerId: { teamId: TEAM_ID, playerId: PLAYER_ID } };

describe('invitation transitions through the real InvitationService (#766)', () => {
  beforeEach(() => {
    mockCaller = { id: PLAYER_ID, role: 'PLAYER' };
    // clearAllMocks keeps implementations: reset the read-back so a test that
    // installs none cannot read the previous test's row.
    mockPrisma.teamInvitation.findUniqueOrThrow.mockReset();
    mockPrisma.teamInvitation.findUnique.mockResolvedValue(invitationRow());
    mockPrisma.teamInvitation.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.teamInvitation.count.mockResolvedValue(0);
    mockPrisma.guardianInvitation.findUnique.mockResolvedValue(null);
    mockPrisma.guardian.findUnique.mockResolvedValue(null);
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.teamMember.upsert.mockResolvedValue({
      id: MEMBER_ID,
      teamId: TEAM_ID,
      playerId: PLAYER_ID,
      jerseyNumber: 0,
      position: 'PG',
      player: { id: PLAYER_ID, name: 'Player' },
      team: { id: TEAM_ID, name: 'Lakers' },
    });
  });

  it('POST /invitations/:id/accept flips PENDING → ACCEPTED and upserts the membership', async () => {
    readBackAfter(() => ({ status: 'ACCEPTED', acceptedAt: new Date() }));

    const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      kind: 'team',
      invitation: { id: INVITATION_ID, status: 'ACCEPTED' },
      teamMember: { id: MEMBER_ID, teamId: TEAM_ID, playerId: PLAYER_ID },
    });
    expectNoToken(res.body);
    expectGuardedTransition('ACCEPTED');
    expect(mockPrisma.teamMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedMemberWhere, update: {} })
    );
  });

  it('POST /invitations/:id/reject flips PENDING → REJECTED and strips an unclaimed email', async () => {
    readBackAfter(() => ({ status: 'REJECTED', rejectedAt: new Date() }));

    const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/reject`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      kind: 'team',
      invitation: { id: INVITATION_ID, status: 'REJECTED', team: { id: TEAM_ID, name: 'Lakers' } },
    });
    expectNoToken(res.body);
    expectGuardedTransition('REJECTED');
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PLAYER_ID, workosUserId: null, deletedAt: null } })
    );
    expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
  });

  it('DELETE /invitations/:id lets a roster manager cancel, without stripping the email', async () => {
    mockCaller = { id: COACH_ID, role: 'COACH' };
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'COACH' });
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM_ID, season: { league: { admins: [] } } });
    mockPrisma.teamStaff.findMany.mockResolvedValue([
      {
        teamId: TEAM_ID,
        userId: COACH_ID,
        role: {
          canManageTeam: true,
          canManageRoster: true,
          canTrackStats: true,
          canViewStats: true,
          canShareStats: true,
        },
      },
    ]);
    readBackAfter(() => ({ status: 'CANCELLED' }));

    const res = await request(app).delete(`/api/v1/invitations/${INVITATION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      invitation: { id: INVITATION_ID, status: 'CANCELLED' },
    });
    expectNoToken(res.body);
    expectGuardedTransition('CANCELLED');
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('POST /invitations/by-token/:token/accept accepts with the token alone', async () => {
    readBackAfter(() => ({ status: 'ACCEPTED', acceptedAt: new Date() }));

    const res = await request(app).post(`/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      kind: 'team',
      invitation: { id: INVITATION_ID, status: 'ACCEPTED' },
      teamMember: { teamId: TEAM_ID, playerId: PLAYER_ID },
    });
    expectNoToken(res.body);
    expect(mockPrisma.teamInvitation.findUnique).toHaveBeenCalledWith({ where: { token: SECRET_TOKEN } });
    expectGuardedTransition('ACCEPTED');
    expect(mockPrisma.teamMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedMemberWhere, update: {} })
    );
  });

  it('a transition that loses the PENDING race answers 400 and writes no membership', async () => {
    mockPrisma.teamInvitation.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post(`/api/v1/invitations/${INVITATION_ID}/accept`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot accept invitation: it is no longer pending');
    expect(mockPrisma.teamInvitation.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockPrisma.teamMember.upsert).not.toHaveBeenCalled();
  });

  describe('omitToken strips a token the read-back leaks (defence in depth)', () => {
    beforeEach(() => {
      // Ignore the select: the row comes back with its token, as an
      // `include`-based query would return it.
      mockPrisma.teamInvitation.findUniqueOrThrow.mockResolvedValue(invitationRow({ status: 'ACCEPTED' }));
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    });

    it.each([
      ['POST', `/api/v1/invitations/${INVITATION_ID}/accept`, PLAYER_ID],
      ['POST', `/api/v1/invitations/${INVITATION_ID}/reject`, PLAYER_ID],
      ['DELETE', `/api/v1/invitations/${INVITATION_ID}`, COACH_ID],
      ['POST', `/api/v1/invitations/by-token/${SECRET_TOKEN}/accept`, PLAYER_ID],
    ])('%s %s', async (method, url, callerId) => {
      mockCaller = { id: callerId, role: callerId === COACH_ID ? 'ADMIN' : 'PLAYER' };
      const res = method === 'DELETE' ? await request(app).delete(url) : await request(app).post(url);

      expect(res.status).toBe(200);
      expectNoToken(res.body);
    });
  });

  describe('GET /invitations/by-token/:token strips a token the lookup leaks (defence in depth)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('team invitation', async () => {
      const leaked: PublicInvitation & { token: string } = {
        id: INVITATION_ID,
        status: 'PENDING',
        teamName: 'Lakers',
        inviterName: 'Coach',
        inviterDeletedAt: null,
        position: 'PG',
        jerseyNumber: 0,
        message: null,
        expiresAt: new Date().toISOString(),
        token: SECRET_TOKEN,
      };
      jest.spyOn(InvitationService, 'getInvitationByToken').mockResolvedValue(leaked);

      const res = await request(app).get(`/api/v1/invitations/by-token/${SECRET_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation).toMatchObject({ kind: 'team', id: INVITATION_ID });
      expectNoToken(res.body);
    });

    it('guardian invitation', async () => {
      const leaked: PublicGuardianInvitation & { token: string } = {
        kind: 'guardian',
        id: INVITATION_ID,
        status: 'PENDING',
        childName: 'Player',
        teamName: 'Lakers',
        inviterName: 'Coach',
        relationship: 'GUARDIAN',
        expiresAt: new Date().toISOString(),
        token: SECRET_TOKEN,
      };
      jest.spyOn(InvitationService, 'getInvitationByToken').mockRejectedValue(new NotFoundError('Invitation not found'));
      jest.spyOn(GuardianService, 'getInvitationByToken').mockResolvedValue(leaked);

      const res = await request(app).get(`/api/v1/invitations/by-token/${SECRET_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.invitation).toMatchObject({ kind: 'guardian', id: INVITATION_ID });
      expectNoToken(res.body);
    });
  });
});
