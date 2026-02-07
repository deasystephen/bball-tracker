/**
 * Teams API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { InvitationService } from '../../src/services/invitation-service';
import { NotFoundError, ForbiddenError } from '../../src/utils/errors';

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-8901-2345-67890abcdef0';
const TEST_LEAGUE_ID = 'c3d4e5f6-a7b8-9012-3456-7890abcdef01';
const TEST_SEASON_ID = 'f6a7b8c9-d0e1-2345-6789-0abcdef01234';
const TEST_PLAYER_ID = 'd4e5f6a7-b8c9-0123-4567-890abcdef012';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the services
jest.mock('../../src/services/team-service');
jest.mock('../../src/services/invitation-service');

const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;
const mockInvitationService = InvitationService as jest.Mocked<typeof InvitationService>;

describe('Teams API', () => {
  const mockTeam = {
    id: TEST_TEAM_ID,
    name: 'Lakers',
    seasonId: TEST_SEASON_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    season: {
      id: TEST_SEASON_ID,
      name: 'Spring 2024',
      league: { id: TEST_LEAGUE_ID, name: 'Spring League' },
    },
    staff: [{ userId: TEST_USER_ID, user: { id: TEST_USER_ID, name: 'Test User', email: 'test@example.com' }, role: { name: 'Head Coach' } }],
    members: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/teams', () => {
    it('should create a team successfully', async () => {
      mockTeamService.createTeam.mockResolvedValue(mockTeam as any);

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.team).toBeDefined();
      expect(mockTeamService.createTeam).toHaveBeenCalledWith(
        { name: 'Lakers', seasonId: TEST_SEASON_ID },
        TEST_USER_ID
      );
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers' }); // Missing seasonId

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for invalid data', async () => {
      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: '', seasonId: TEST_SEASON_ID }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should handle service errors', async () => {
      mockTeamService.createTeam.mockRejectedValue(new NotFoundError('Season not found'));

      const response = await request(app)
        .post('/api/v1/teams')
        .send({ name: 'Lakers', seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Season not found');
    });
  });

  describe('GET /api/v1/teams', () => {
    it('should list teams successfully', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [mockTeam],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/teams');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.teams).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should filter teams by leagueId', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [mockTeam],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/teams')
        .query({ leagueId: TEST_LEAGUE_ID });

      expect(response.status).toBe(200);
      expect(mockTeamService.listTeams).toHaveBeenCalledWith(
        expect.objectContaining({ leagueId: TEST_LEAGUE_ID }),
        TEST_USER_ID
      );
    });

    it('should filter teams by seasonId', async () => {
      mockTeamService.listTeams.mockResolvedValue({
        teams: [mockTeam],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/teams')
        .query({ seasonId: TEST_SEASON_ID });

      expect(response.status).toBe(200);
      expect(mockTeamService.listTeams).toHaveBeenCalledWith(
        expect.objectContaining({ seasonId: TEST_SEASON_ID }),
        TEST_USER_ID
      );
    });
  });

  describe('GET /api/v1/teams/:id', () => {
    it('should get a team by ID', async () => {
      mockTeamService.getTeamById.mockResolvedValue(mockTeam as any);

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.team.id).toBe(TEST_TEAM_ID);
    });

    it('should return 404 for non-existent team', async () => {
      mockTeamService.getTeamById.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app).get('/api/v1/teams/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Team not found');
    });

    it('should return 403 for forbidden access', async () => {
      mockTeamService.getTeamById.mockRejectedValue(new ForbiddenError('Access denied'));

      const response = await request(app).get(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Access denied');
    });
  });

  describe('PATCH /api/v1/teams/:id', () => {
    it('should update a team successfully', async () => {
      const updatedTeam = { ...mockTeam, name: 'Updated Lakers' };
      mockTeamService.updateTeam.mockResolvedValue(updatedTeam as any);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ name: 'Updated Lakers' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.team.name).toBe('Updated Lakers');
    });

    it('should return 400 for invalid update data', async () => {
      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ name: '' }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent team', async () => {
      mockTeamService.updateTeam.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app)
        .patch('/api/v1/teams/00000000-0000-0000-0000-000000000000')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized update', async () => {
      mockTeamService.updateTeam.mockRejectedValue(new ForbiddenError('Not authorized'));

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/teams/:id', () => {
    it('should delete a team successfully', async () => {
      mockTeamService.deleteTeam.mockResolvedValue(undefined as any);

      const response = await request(app).delete(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Team deleted successfully');
    });

    it('should return 404 for non-existent team', async () => {
      mockTeamService.deleteTeam.mockRejectedValue(new NotFoundError('Team not found'));

      const response = await request(app).delete('/api/v1/teams/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
    });

    it('should return 403 for unauthorized delete', async () => {
      mockTeamService.deleteTeam.mockRejectedValue(new ForbiddenError('Not authorized'));

      const response = await request(app).delete(`/api/v1/teams/${TEST_TEAM_ID}`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/teams/:id/players (deprecated)', () => {
    it('should return 410 Gone for deprecated endpoint', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/players`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(410);
      expect(response.body.deprecated).toBe(true);
    });
  });

  describe('POST /api/v1/teams/:teamId/invitations', () => {
    const mockInvitation = {
      id: 'f6a7b8c9-d0e1-2345-6789-0abcdef01234',
      teamId: TEST_TEAM_ID,
      playerId: TEST_PLAYER_ID,
      invitedById: TEST_USER_ID,
      status: 'PENDING',
      token: 'abc123',
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should create an invitation successfully', async () => {
      mockInvitationService.createInvitation.mockResolvedValue(mockInvitation as any);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.invitation).toBeDefined();
    });

    it('should return 400 for missing playerId', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('should handle service errors', async () => {
      mockInvitationService.createInvitation.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/invitations`)
        .send({ playerId: TEST_PLAYER_ID });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/teams/:id/players/:playerId', () => {
    it('should remove a player from team successfully', async () => {
      mockTeamService.removePlayer.mockResolvedValue(undefined as any);

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Player removed from team successfully');
    });

    it('should return 404 for non-existent team or player', async () => {
      mockTeamService.removePlayer.mockRejectedValue(new NotFoundError('Not found'));

      const response = await request(app)
        .delete(`/api/v1/teams/${TEST_TEAM_ID}/players/00000000-0000-0000-0000-000000000000`);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/teams/:id/players/:playerId', () => {
    const mockTeamMember = {
      id: 'a7b8c9d0-e1f2-3456-7890-abcdef012345',
      teamId: TEST_TEAM_ID,
      playerId: TEST_PLAYER_ID,
      jerseyNumber: 23,
      position: 'Guard',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should update a team member successfully', async () => {
      mockTeamService.updateTeamMember.mockResolvedValue(mockTeamMember as any);

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/${TEST_PLAYER_ID}`)
        .send({ jerseyNumber: 23, position: 'Guard' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.teamMember.jerseyNumber).toBe(23);
    });

    it('should return 404 for non-existent team member', async () => {
      mockTeamService.updateTeamMember.mockRejectedValue(new NotFoundError('Not found'));

      const response = await request(app)
        .patch(`/api/v1/teams/${TEST_TEAM_ID}/players/00000000-0000-0000-0000-000000000000`)
        .send({ jerseyNumber: 23 });

      expect(response.status).toBe(404);
    });
  });
});

afterAll((done) => {
  if (httpServer) {
    httpServer.close(() => done());
  } else {
    done();
  }
});
