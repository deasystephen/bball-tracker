/**
 * API test for POST /api/v1/teams/:teamId/staff with the real TeamService:
 * one staff role per user per team (#463).
 *
 * `tests/api/teams.test.ts` mocks TeamService wholesale. Here the request runs
 * validation -> route -> TeamService.addStaffMember -> (mocked) Prisma, the
 * same path as production. A user who already holds a role on the team gets
 * 400 with the PATCH hint's message, whether the pre-check sees the row or a
 * concurrent add wins the `[teamId, userId]` unique index. What Postgres does
 * with that index is covered by `tests/integration/team-staff-single-role.db.test.ts`.
 *
 * DELETE /teams/:teamId/staff/:userId runs the same way: the last-head-coach
 * guard and the delete share one transaction behind the team row lock, and a
 * target with no staff row (or one a concurrent removal took first) is a 404.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import { Prisma } from '@prisma/client';
import { uniqueViolation } from '../factories';
import { invalidateUsage } from '../../src/services/usage-service';

const HEAD_COACH_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const ASSISTANT_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const LEAGUE_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const MANAGER_ROLE_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';
const ALREADY_STAFF = 'User is already a staff member of this team';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'coach@example.com',
      name: 'Casey Coach',
      role: 'COACH',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    };
    next();
  }),
}));

jest.mock('../../src/services/usage-service', () => ({
  canCreateTeam: jest.fn().mockResolvedValue(true),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

/** The caller is the team's head coach; the target user exists. */
function givenHeadCoachAddingAssistant(): void {
  (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
    id: TEAM_ID,
    name: 'Hornets',
    season: { leagueId: LEAGUE_ID },
  });
  (mockPrisma.user.findUnique as jest.Mock).mockImplementation(
    (args: { where: { id: string } }) =>
      Promise.resolve(
        args.where.id === HEAD_COACH_ID
          ? { id: HEAD_COACH_ID, name: 'Casey Coach', role: 'COACH' }
          : { id: ASSISTANT_ID, name: 'Alex Assistant', role: 'COACH' }
      )
  );
  (mockPrisma.leagueAdmin.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.teamRole.findFirst as jest.Mock).mockResolvedValue({
    id: MANAGER_ROLE_ID,
    teamId: TEAM_ID,
    type: 'TEAM_MANAGER',
    name: 'Team Manager',
  });
  // canManageStaff: the caller holds the team's HEAD_COACH row.
  (mockPrisma.teamStaff.findFirst as jest.Mock).mockResolvedValue({ id: 'head-row' });
}

/** The target's existing staff row on the team, or none. */
function givenTargetStaffRow(row: Record<string, unknown> | null): void {
  (mockPrisma.teamStaff.findUnique as jest.Mock).mockResolvedValue(row);
}

describe('POST /api/v1/teams/:teamId/staff — one role per user per team (#463)', () => {
  afterAll((done) => {
    if (httpServer) {
      httpServer.close(() => done());
    } else {
      done();
    }
  });

  it('answers 400 when the user already holds a role on the team, and writes nothing', async () => {
    givenHeadCoachAddingAssistant();
    // The target already holds an ASSISTANT_COACH row on the team.
    givenTargetStaffRow({ id: 'assistant-row', teamId: TEAM_ID, userId: ASSISTANT_ID, roleId: 'assistant-role' });

    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/staff`)
      .send({ userId: ASSISTANT_ID, roleType: 'TEAM_MANAGER' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(ALREADY_STAFF);
    expect(mockPrisma.teamStaff.create).not.toHaveBeenCalled();
  });

  it('answers the same 400 when a concurrent add with another role wins the [teamId, userId] index', async () => {
    givenHeadCoachAddingAssistant();
    givenTargetStaffRow(null);
    (mockPrisma.teamStaff.create as jest.Mock).mockRejectedValue(
      uniqueViolation('TeamStaff_teamId_userId_key')
    );

    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/staff`)
      .send({ userId: ASSISTANT_ID, roleType: 'TEAM_MANAGER' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(ALREADY_STAFF);
  });

  it('adds a user who holds no role on the team (201)', async () => {
    givenHeadCoachAddingAssistant();
    givenTargetStaffRow(null);
    (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({
      id: 'new-row',
      teamId: TEAM_ID,
      userId: ASSISTANT_ID,
      roleId: MANAGER_ROLE_ID,
      user: { id: ASSISTANT_ID, name: 'Alex Assistant' },
      role: { id: MANAGER_ROLE_ID, type: 'TEAM_MANAGER', name: 'Team Manager' },
    });

    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/staff`)
      .send({ userId: ASSISTANT_ID, roleType: 'TEAM_MANAGER' });

    expect(response.status).toBe(201);
    expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { teamId: TEAM_ID, userId: ASSISTANT_ID, roleId: MANAGER_ROLE_ID } })
    );
  });
});

describe('DELETE /api/v1/teams/:teamId/staff/:userId through the real TeamService (#463)', () => {
  afterAll((done) => {
    if (httpServer) {
      httpServer.close(() => done());
    } else {
      done();
    }
  });

  const ASSISTANT_ROW = {
    id: 'assistant-row',
    teamId: TEAM_ID,
    userId: ASSISTANT_ID,
    roleId: 'assistant-role',
    role: { id: 'assistant-role', type: 'ASSISTANT_COACH' },
  };

  /** The caller is the team's head coach removing the assistant, who is not a head coach. */
  function givenHeadCoachRemovingAssistant(targetRow: typeof ASSISTANT_ROW | null): void {
    givenHeadCoachAddingAssistant();
    givenTargetStaffRow(targetRow);
  }

  it('removes the staff member (200) and refreshes their usage', async () => {
    givenHeadCoachRemovingAssistant(ASSISTANT_ROW);
    (mockPrisma.teamStaff.delete as jest.Mock).mockResolvedValue(ASSISTANT_ROW);

    const response = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff/${ASSISTANT_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, message: 'Staff member removed successfully' });
    expect(invalidateUsage).toHaveBeenCalledWith(ASSISTANT_ID);
  });

  it('answers 404 when the user holds no staff row on the team', async () => {
    givenHeadCoachRemovingAssistant(null);

    const response = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff/${ASSISTANT_ID}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('User is not a staff member of this team');
    expect(mockPrisma.teamStaff.delete).not.toHaveBeenCalled();
    expect(invalidateUsage).not.toHaveBeenCalled();
  });

  it('answers the same 404 when the row vanishes before the delete (P2025)', async () => {
    givenHeadCoachRemovingAssistant(ASSISTANT_ROW);
    (mockPrisma.teamStaff.delete as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('No record was found', { code: 'P2025', clientVersion: 'test' })
    );

    const response = await request(app).delete(`/api/v1/teams/${TEAM_ID}/staff/${ASSISTANT_ID}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('User is not a staff member of this team');
    expect(invalidateUsage).not.toHaveBeenCalled();
  });
});
