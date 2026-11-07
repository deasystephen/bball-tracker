/**
 * API test for POST /api/v1/teams/:id/rollover with the real TeamService (#461).
 *
 * The request runs validation -> route (deliberately without `requireTeamCreateLimit`) ->
 * TeamService.rolloverTeam -> (mocked) Prisma, the same path as production.
 * The permission helpers are spied so a test states the caller's standing;
 * what Postgres does with the transaction is covered by
 * `tests/integration/team-rollover.db.test.ts`.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import * as permissions from '../../src/utils/permissions';
import { mockPrisma } from '../setup';
import { TEST_TEAM_LIMIT, lineageRows, withFiniteFreeTeamLimit } from '../helpers';

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
  name: 'Hornets',
  seasonId: SEASON_ID,
  season: { leagueId: LEAGUE_ID },
  lineageId: LINEAGE_ID,
  chatLink: null,
  ageGroup: 'U12',
  gender: null,
  roles: [],
  staff: [],
  members: [],
};

/** The pre-check read, the sibling probe and the final read, by query shape. */
function mockTeamReads(sibling: { id: string } | null): void {
  (mockPrisma.team.findUnique as jest.Mock).mockImplementation(
    (args: { where: Record<string, unknown>; include?: unknown }) => {
      if (args.where.lineageId_seasonId) return Promise.resolve(sibling);
      if ((args as { select?: Record<string, unknown> }).select?.members) {
        return Promise.resolve({ staff: [], members: [] });
      }
      if (args.include) {
        return Promise.resolve({
          id: args.where.id,
          name: 'Hornets',
          seasonId: NEXT_SEASON_ID,
          lineageId: LINEAGE_ID,
          season: { id: NEXT_SEASON_ID, name: '2027', league: { id: LEAGUE_ID, name: "Casey Coach's Teams" } },
          staff: [],
          members: [],
        });
      }
      return Promise.resolve({ id: TEAM_ID, lineageId: LINEAGE_ID, season: { leagueId: LEAGUE_ID } });
    }
  );
}

/**
 * Season-by-name lookups answer `seasonRows` in order; the latest-row query
 * answers `latest` (default: the source team); a picked season's share lock
 * finds it in the team's league; every other lock finds its row.
 */
function mockRaw(seasonRows: Array<{ id: string }[]> = [[], [], []], latest: string = TEAM_ID): void {
  const queue = [...seasonRows];
  (mockPrisma.$queryRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('JOIN "Season"')) return Promise.resolve([{ id: latest }]);
    if (sql.includes('FOR KEY SHARE')) return Promise.resolve([{ leagueId: LEAGUE_ID }]);
    if (sql.includes('FROM "Season"')) return Promise.resolve(queue.shift() ?? []);
    return Promise.resolve([{ id: 'locked' }]);
  });
}

let spies: Record<string, jest.SpyInstance> = {};

beforeEach(() => {
  spies = {
    canManageStaff: jest.spyOn(permissions, 'canManageStaff').mockResolvedValue(true),
    isLeagueAdmin: jest.spyOn(permissions, 'isLeagueAdmin').mockResolvedValue(true),
    hasTeamPermission: jest.spyOn(permissions, 'hasTeamPermission').mockResolvedValue(true),
  };
  mockTeamReads(null);
  mockRaw();
  (mockPrisma.team.findUniqueOrThrow as jest.Mock).mockResolvedValue(source);
  (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
  (mockPrisma.season.createMany as jest.Mock).mockResolvedValue({ count: 1 });
  (mockPrisma.season.findUniqueOrThrow as jest.Mock).mockResolvedValue({ id: NEXT_SEASON_ID });
  (mockPrisma.team.create as jest.Mock).mockResolvedValue({ id: NEW_TEAM_ID });
  (mockPrisma.teamRole.createManyAndReturn as jest.Mock).mockResolvedValue([]);
});

afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  (mockPrisma.$queryRaw as jest.Mock).mockReset().mockResolvedValue([{ '?column?': 1 }]);
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
    // The trimmed name reached the case-insensitive lookup.
    const [, ...values] = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual([LEAGUE_ID, '2027']);
    expect(mockPrisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ageGroup: 'U13', lineageId: LINEAGE_ID }) })
    );
    // WHO ran for the authenticated caller, before and behind the team lock.
    expect(permissions.canManageStaff).toHaveBeenCalledTimes(2);
    expect(permissions.canManageStaff).toHaveBeenCalledWith(COACH_ID, TEAM_ID);
    expect(permissions.canManageStaff).toHaveBeenLastCalledWith(COACH_ID, TEAM_ID, mockPrisma);
  });

  it('reuses a differently cased season instead of creating a near-duplicate', async () => {
    mockRaw([[{ id: NEXT_SEASON_ID }]]);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: 'spring 2025' });

    expect(response.status).toBe(201);
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
  });

  it('answers 200 with created: false and the existing row to a coach who manages it', async () => {
    mockTeamReads({ id: NEW_TEAM_ID });
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON_ID, leagueId: LEAGUE_ID });

    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/rollover`)
      .send({ seasonId: NEXT_SEASON_ID });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, created: false, team: { id: NEW_TEAM_ID } });
    expect(mockPrisma.team.create).not.toHaveBeenCalled();
  });

  it('answers 409 with no id when the coach was removed from the existing row', async () => {
    mockTeamReads({ id: NEW_TEAM_ID });
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON_ID, leagueId: LEAGUE_ID });
    // Head coach of last season's row, no longer on this season's.
    spies.hasTeamPermission.mockImplementation((_user: string, teamId: string) => Promise.resolve(teamId === TEAM_ID));

    const response = await request(app)
      .post(`/api/v1/teams/${TEAM_ID}/rollover`)
      .send({ seasonId: NEXT_SEASON_ID });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'This team already has a team-season in that season',
      code: 'team_season_exists',
    });
  });

  it("answers 409 not_latest_season, no ids, when a coach removed from this season rolls last season's row", async () => {
    // Last season's row (the caller is still its head coach); the lineage's
    // latest row is this season's, and nothing exists yet in the target.
    mockRaw([[], [], []], NEW_TEAM_ID);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2028' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Only the team's most recent season can start the next one",
      code: 'not_latest_season',
    });
    expect(mockPrisma.team.create).not.toHaveBeenCalled();
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
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
    spies.canManageStaff.mockResolvedValue(false);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

    expect(response.status).toBe(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 403 when a new season is needed and the caller is not a league admin', async () => {
    spies.isLeagueAdmin.mockResolvedValue(false);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

    expect(response.status).toBe(403);
    expect(mockPrisma.season.createMany).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown team', async () => {
    (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

    expect(response.status).toBe(404);
  });

  it("answers the same 404 for another league's season as for a missing one", async () => {
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: NEXT_SEASON_ID, leagueId: 'another-league' });
    const foreign = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonId: NEXT_SEASON_ID });

    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue(null);
    const missing = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonId: NEXT_SEASON_ID });

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });

  it("answers 400 for the team's own season", async () => {
    (mockPrisma.season.findUnique as jest.Mock).mockResolvedValue({ id: SEASON_ID, leagueId: LEAGUE_ID });

    const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonId: SEASON_ID });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('The team is already in that season');
  });

  describe('with a finite FREE team limit', () => {
    withFiniteFreeTeamLimit();

    it('is not behind the team cap: a coach at the cap still continues their team (it adds no lineage)', async () => {
      (mockPrisma.team.groupBy as jest.Mock).mockResolvedValue(lineageRows(TEST_TEAM_LIMIT));

      const response = await request(app).post(`/api/v1/teams/${TEAM_ID}/rollover`).send({ seasonName: '2027' });

      expect(response.status).toBe(201);
      expect(mockPrisma.team.groupBy).not.toHaveBeenCalled();
    });
  });
});
