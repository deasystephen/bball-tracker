/**
 * GET /api/v1/stats/players/:playerId, through the route and the real service
 * (#589). `stats.test.ts` mocks the whole service, so it cannot show what the
 * endpoint answers to a guardian; this file mocks only the database.
 *
 * Who the database grants access to is proven against real Postgres in
 * `tests/integration/player-stats-access.db.test.ts`.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { mockPrisma } from '../setup';
import { teamAccessWhere } from '../../src/utils/permissions';

const GUARDIAN_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const CHILD_ID = 'd4e5f6a7-b8c9-4123-a567-890abcdef012';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'gloria.james@example.com',
      name: 'Gloria James',
      role: 'PARENT',
    };
    next();
  }),
}));

const membership = {
  id: 'member-1',
  teamId: TEAM_ID,
  playerId: CHILD_ID,
  team: {
    id: TEAM_ID,
    name: 'Lakers',
    season: { id: 'season-1', name: '2026', league: { id: 'league-1', name: 'Downtown Youth' } },
  },
};

function givenTheChildIsOnATeam(): void {
  (mockPrisma.user.findUnique as jest.Mock).mockImplementation((args: { where: { id: string } }) => {
    if (args.where.id === CHILD_ID) return Promise.resolve({ id: CHILD_ID, name: 'Bryce James' });
    return Promise.resolve({ role: 'PARENT' });
  });
  (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([membership]);
  (mockPrisma.game.findMany as jest.Mock).mockResolvedValue([]);
  (mockPrisma.playerStats.findMany as jest.Mock).mockResolvedValue([]);
}

describe('GET /api/v1/stats/players/:playerId as a guardian', () => {
  afterAll((done) => {
    if (httpServer) {
      httpServer.close(() => done());
    } else {
      done();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('answers 200 with the child\'s teams', async () => {
    givenTheChildIsOnATeam();
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([{ childId: CHILD_ID }]);
    (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([{ id: TEAM_ID }]);

    const response = await request(app).get(`/api/v1/stats/players/${CHILD_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.player).toEqual({ id: CHILD_ID, name: 'Bryce James' });
    expect(response.body.teams).toHaveLength(1);
    expect(response.body.teams[0]).toEqual(
      expect.objectContaining({ teamId: TEAM_ID, teamName: 'Lakers', seasonName: 'Downtown Youth - 2026' })
    );
    expect(response.body.careerTotals.gamesPlayed).toBe(0);

    // The access query carries the guardian branch for this child.
    expect(mockPrisma.team.findMany).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [TEAM_ID] } }, teamAccessWhere(GUARDIAN_ID, [CHILD_ID])] },
      select: { id: true },
    });
  });

  it('answers 403 with the reason when no team of the player can be read', async () => {
    givenTheChildIsOnATeam();
    (mockPrisma.guardian.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.team.findMany as jest.Mock).mockResolvedValue([]);

    const response = await request(app).get(`/api/v1/stats/players/${CHILD_ID}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("You do not have access to this player's teams");
    expect(response.body.teams).toBeUndefined();
  });

  it('answers 404 for a player with no team, before any access query', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: CHILD_ID, name: 'Bryce James' });
    (mockPrisma.teamMember.findMany as jest.Mock).mockResolvedValue([]);

    const response = await request(app).get(`/api/v1/stats/players/${CHILD_ID}`);

    expect(response.status).toBe(404);
    expect(mockPrisma.team.findMany).not.toHaveBeenCalled();
  });

  it('answers 400 for an id that is not a UUID', async () => {
    const response = await request(app).get('/api/v1/stats/players/not-a-uuid');

    expect(response.status).toBe(400);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });
});
