/**
 * API test for POST /api/v1/teams with the real TeamService (#765).
 *
 * `tests/api/teams.test.ts` mocks TeamService wholesale. Here the service is
 * NOT mocked: the request runs validation -> route -> TeamService.createTeam ->
 * (mocked) Prisma -> usage-cache invalidation, the same path as production.
 * What Postgres does with the transaction is covered by
 * `tests/integration/team-create.db.test.ts`.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';

const COACH_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const LEAGUE_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const SEASON_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const LINEAGE_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const ROLE_ID = 'e5f6a7b8-c9d0-4234-a678-90abcdef0123';

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
  ...jest.requireActual('../../src/services/usage-service'),
  invalidateUsage: jest.fn().mockResolvedValue(undefined),
}));

import { invalidateUsage } from '../../src/services/usage-service';

const mockInvalidateUsage = invalidateUsage as jest.Mock;

const createdTeam = {
  id: TEAM_ID,
  name: 'Hornets',
  seasonId: SEASON_ID,
  lineageId: LINEAGE_ID,
  chatLink: null,
  ageGroup: null,
  gender: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('POST /api/v1/teams through the real TeamService', () => {
  beforeEach(() => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      name: 'Casey Coach',
      role: 'COACH',
      subscriptionTier: 'FREE',
      subscriptionExpiresAt: null,
    });
    (mockPrisma.league.upsert as jest.Mock).mockResolvedValue({ id: LEAGUE_ID });
    (mockPrisma.leagueAdmin.upsert as jest.Mock).mockResolvedValue({ id: 'la-1' });
    (mockPrisma.season.upsert as jest.Mock).mockResolvedValue({ id: SEASON_ID });
    (mockPrisma.teamLineage.create as jest.Mock).mockResolvedValue({ id: LINEAGE_ID });
    (mockPrisma.team.create as jest.Mock).mockResolvedValue(createdTeam);
    (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 3 });
    (mockPrisma.teamRole.findUnique as jest.Mock).mockResolvedValue({ id: ROLE_ID, name: 'Head Coach' });
    (mockPrisma.teamStaff.create as jest.Mock).mockResolvedValue({ teamId: TEAM_ID, userId: COACH_ID, roleId: ROLE_ID });
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({
      ...createdTeam,
      season: { id: SEASON_ID, name: '2026', league: { id: LEAGUE_ID, name: "Casey Coach's Teams" } },
      staff: [],
      members: [],
    });
  });

  it('creates the team in the personal league and invalidates the cached usage after the service', async () => {
    const res = await request(app).post('/api/v1/teams').send({ name: 'Hornets' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, team: { id: TEAM_ID, name: 'Hornets', seasonId: SEASON_ID } });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.league.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { personalOwnerId: COACH_ID } })
    );
    expect(mockPrisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Hornets', seasonId: SEASON_ID, lineageId: LINEAGE_ID }),
    });
    expect(mockPrisma.teamStaff.create).toHaveBeenCalledWith({
      data: { teamId: TEAM_ID, userId: COACH_ID, roleId: ROLE_ID },
    });

    // The row lock is the transaction's first statement, before provisioning.
    const lockOrder = (mockPrisma.$queryRaw as jest.Mock).mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan((mockPrisma.league.upsert as jest.Mock).mock.invocationCallOrder[0]);

    // Invalidated once, for the caller, after the service has read the team back.
    expect(mockInvalidateUsage).toHaveBeenCalledTimes(1);
    expect(mockInvalidateUsage).toHaveBeenCalledWith(COACH_ID);
    const readBack = (mockPrisma.team.findUnique as jest.Mock).mock.invocationCallOrder;
    expect(mockInvalidateUsage.mock.invocationCallOrder[0]).toBeGreaterThan(readBack[readBack.length - 1]);
  });

  it('does not invalidate the usage cache when the service fails', async () => {
    (mockPrisma.team.create as jest.Mock).mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/v1/teams').send({ name: 'Hornets' });

    expect(res.status).toBe(500);
    expect(mockInvalidateUsage).not.toHaveBeenCalled();
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
