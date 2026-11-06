/**
 * API test for POST /api/v1/teams/:id/rollover with the real TeamService (#461).
 *
 * The request runs validation -> route -> TeamService.rolloverTeam -> (mocked)
 * Prisma, the same path as production. The permission helpers are spied so a
 * test states the caller's standing; what Postgres does with the transaction
 * is covered by `tests/integration/team-rollover.db.test.ts`.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import * as permissions from '../../src/utils/permissions';
import { mockPrisma } from '../setup';

const COACH_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const LEAGUE_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const SEASON_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const NEXT_SEASON_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01235';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';
const NEW_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef1';
const LINEAGE_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';

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

const source = {
  id: TEAM_ID,
  name: 'Hornets',
  seasonId: SEASON_ID,
  lineageId: LINEAGE_ID,
  chatLink: null,
  ageGroup: 'U12',
  gender: null,
  season: { leagueId: LEAGUE_ID },
};

/** The source read, the sibling probe and the final read, by query shape. */
function mockTeamReads(sibling: { id: string } | null): void {
  (mockPrisma.team.findUnique as jest.Mock).mockImplementation(
    (args: { where: Record<string, unknown>; include?: unknown }) => {
      if (args.where.lineageId_seasonId) return Promise.resolve(sibling);
      if (args.include) {
        return Promise.resolve({
          id: args.where.id,
          name: 'Hornets',
          seasonId: NEXT_SEASON_ID,
          lineageId: LINEAGE_ID,
          season: { id: NEXT_SEASON_ID, name: '2027', league: { id: LEAGUE_ID, name: 'Casey Coach\'s Teams' } },
          staff: [],
          members: [],
        });
      }
      return Promise.resolve(source);
    }
  );
}

let spies: jest.SpyInstance[] = [];

beforeEach(() => {
  spies = [
    jest.spyOn(permissions, 'canManageStaff').mockResolvedValue(true),
    jest.spyOn(permissions, 'canWriteLeague').mockResolvedValue(true),
    jest.spyOn(permissions, 'isLeagueAdmin').mockResolvedValue(true),
  ];
  mockTeamReads(null);
  (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.season.upsert as jest.Mock).mockResolvedValue({ id: NEXT_SEASON_ID });
  (mockPrisma.team.create as jest.Mock).mockResolvedValue({ id: NEW_TEAM_ID });
  (mockPrisma.teamRole.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.teamRole.createMany as jest.Mock).mockResolvedValue({ count: 0 });
  (mockPrisma.teamStaff.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

afterAll((done) => {
  if (httpServer.listening) {
    httpServer.close(() => done());
  } else {
    done();
  }
});

describe('POST /api/v1/teams/:id/rollover', () => {
  it('answers 201 with created: true and the new team-season', async () => {
    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/rollover`)
      .send({ seasonName: ' 2027 ', ageGroup: 'U13' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      created: true,
      team: { id: NEW_TEAM_ID, seasonId: NEXT_SEASON_ID, lineageId: LINEAGE_ID },
    });
    // The season name reached the service trimmed.
    expect(mockPrisma.season.findUnique).toHaveBeenCalledWith({
      where: { leagueId_name: { leagueId: LEAGUE_ID, name: '2027' } },
      select: { id: true },
    });
    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ageGroup: 'U13', lineageId: LINEAGE_ID }) })
    );
    // Both checks ran for the authenticated caller.
    expect(permissions.canManageStaff).toHaveBeenCalledWith(COACH_ID, TEAM_ID);
    expect(permissions.canWriteLeague).toHaveBeenCalledWith(COACH_ID, LEAGUE_ID);
  });

  it('answers 200 with created: false and the existing row on a repeat', async () => {
    mockTeamReads({ id: NEW_TEAM_ID });
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON_ID, leagueId: LEAGUE_ID });

    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/rollover`)
      .send({ seasonId: NEXT_SEASON_ID });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, created: false, team: { id: NEW_TEAM_ID } });
    expect(mockPrisma.team.create).not.toHaveBeenCalled();
  });

  it.each([
    ['neither season field', {}],
    ['both season fields', { seasonId: NEXT_SEASON_ID, seasonName: '2027' }],
    ['a blank season name', { seasonName: '   ' }],
    ['a malformed seasonId', { seasonId: 'nope' }],
    ['an over-long age group', { seasonName: '2027', ageGroup: 'x'.repeat(21) }],
  ])('answers 400 for %s', async (_label, body) => {
    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send(body);

    expect(response.status).toBe(400);
    expect(mockPrisma.team.findUnique).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed team id', async () => {
    const response = await request(app).post('/api/v1/teams/not-a-uuid/rollover').send({ seasonName: '2027' });
    expect(response.status).toBe(400);
  });

  it('answers 403 when the caller is not a head coach of the team', async () => {
    spies[0].mockResolvedValue(false);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

    expect(response.status).toBe(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 403 when a new season is needed and the caller is not a league admin', async () => {
    spies[2].mockResolvedValue(false);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

    expect(response.status).toBe(403);
    expect(mockPrisma.season.upsert).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown team', async () => {
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

    expect(response.status).toBe(404);
  });

  it("answers 400 for the team's own season", async () => {
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: SEASON_ID, leagueId: LEAGUE_ID });

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonId: SEASON_ID });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('The team is already in that season');
  });
});
