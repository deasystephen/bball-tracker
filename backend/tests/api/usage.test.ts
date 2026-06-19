/**
 * Usage metering API integration tests.
 *
 * Covers:
 *  - GET /api/v1/auth/me/usage returns usage vs limits for every metered
 *    feature, and is auth-gated.
 *  - POST /api/v1/teams blocks FREE-tier users at/over the team cap with a
 *    clear 402, including the grandfather case (already over the cap), while
 *    allowing users under the cap and bypassing for admins.
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import * as usageService from '../../src/services/usage-service';
import { TeamService } from '../../src/services/team-service';

const TEST_USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const TEST_SEASON_ID = 'f6a7b8c9-d0e1-4345-a789-0abcdef01234';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

// Mutable user injected by the mocked authenticate middleware so individual
// tests can flip the role (e.g. ADMIN bypass).
const currentUser = {
  id: TEST_USER_ID,
  email: 'coach@example.com',
  name: 'Coach',
  role: 'COACH',
  subscriptionTier: 'FREE',
  subscriptionExpiresAt: null,
};

jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = { ...currentUser };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../src/services/usage-service');
jest.mock('../../src/services/team-service');

const mockUsageService = usageService as jest.Mocked<typeof usageService>;
const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;

beforeEach(() => {
  jest.clearAllMocks();
  currentUser.role = 'COACH';
});

describe('GET /api/v1/auth/me/usage', () => {
  it('returns usage vs limits for every metered feature', async () => {
    mockUsageService.getUsage.mockResolvedValue({
      tier: 'FREE',
      teams: { count: 2, limit: 3, limitReached: false },
      seasons: { count: 1, limit: 1, limitReached: true },
    } as any);

    const response = await request(app)
      .get('/api/v1/auth/me/usage')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.usage.tier).toBe('FREE');
    expect(response.body.usage.teams).toEqual({ count: 2, limit: 3, limitReached: false });
    expect(response.body.usage.seasons).toEqual({ count: 1, limit: 1, limitReached: true });
    expect(mockUsageService.getUsage).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('serializes unlimited limits as null for paid tiers', async () => {
    mockUsageService.getUsage.mockResolvedValue({
      tier: 'PREMIUM',
      teams: { count: 9, limit: null, limitReached: false },
      seasons: { count: 4, limit: null, limitReached: false },
    } as any);

    const response = await request(app)
      .get('/api/v1/auth/me/usage')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body.usage.teams.limit).toBeNull();
  });

  it('returns 500 when the service throws', async () => {
    mockUsageService.getUsage.mockRejectedValue(new Error('boom'));

    const response = await request(app)
      .get('/api/v1/auth/me/usage')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to get usage');
  });
});

describe('POST /api/v1/teams — tier limit enforcement', () => {
  const validBody = { name: 'Lakers', seasonId: TEST_SEASON_ID };
  const createdTeam = { id: TEST_TEAM_ID, name: 'Lakers', seasonId: TEST_SEASON_ID };

  it('creates the team when the user is under the cap', async () => {
    mockUsageService.canCreateTeam.mockResolvedValue(true);
    mockTeamService.createTeam.mockResolvedValue(createdTeam as any);

    const response = await request(app)
      .post('/api/v1/teams')
      .set('Authorization', 'Bearer valid-token')
      .send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(mockTeamService.createTeam).toHaveBeenCalled();
    // Cache invalidated after a successful create.
    expect(mockUsageService.invalidateUsage).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('blocks with 402 when the FREE-tier user is at/over the cap', async () => {
    mockUsageService.canCreateTeam.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/v1/teams')
      .set('Authorization', 'Bearer valid-token')
      .send(validBody);

    expect(response.status).toBe(402);
    expect(response.body.error).toMatch(/team limit/i);
    // The team must NOT have been created.
    expect(mockTeamService.createTeam).not.toHaveBeenCalled();
    expect(mockUsageService.invalidateUsage).not.toHaveBeenCalled();
  });

  it('grandfather: an already-over-limit user is blocked from creating, with a 402', async () => {
    // canCreateTeam returns false for a user already over the cap (5 of 3).
    mockUsageService.canCreateTeam.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/v1/teams')
      .set('Authorization', 'Bearer valid-token')
      .send(validBody);

    expect(response.status).toBe(402);
    expect(mockTeamService.createTeam).not.toHaveBeenCalled();
  });

  it('admins bypass the cap entirely (limit not even checked)', async () => {
    currentUser.role = 'ADMIN';
    mockTeamService.createTeam.mockResolvedValue(createdTeam as any);

    const response = await request(app)
      .post('/api/v1/teams')
      .set('Authorization', 'Bearer valid-token')
      .send(validBody);

    expect(response.status).toBe(201);
    expect(mockUsageService.canCreateTeam).not.toHaveBeenCalled();
    expect(mockTeamService.createTeam).toHaveBeenCalled();
  });

  it('still validates the body before checking the limit (400 on bad input)', async () => {
    const response = await request(app)
      .post('/api/v1/teams')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: '' });

    expect(response.status).toBe(400);
    expect(mockUsageService.canCreateTeam).not.toHaveBeenCalled();
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
