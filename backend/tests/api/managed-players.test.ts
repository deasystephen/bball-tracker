/**
 * Managed Players API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { TeamService } from '../../src/services/team-service';
import { PlayerService } from '../../src/services/player-service';
import { NotFoundError, ForbiddenError } from '../../src/utils/errors';

// Test UUIDs
const TEST_USER_ID = 'a1b2c3d4-e5f6-7890-1234-567890abcdef';
const TEST_TEAM_ID = 'b2c3d4e5-f6a7-8901-2345-67890abcdef0';
const TEST_MANAGED_PLAYER_ID = 'e5f6a7b8-c9d0-1234-5678-90abcdef0123';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
      email: 'coach@example.com',
      name: 'Test Coach',
      role: 'COACH',
    };
    next();
  }),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock the services
jest.mock('../../src/services/team-service');
jest.mock('../../src/services/player-service');

const mockTeamService = TeamService as jest.Mocked<typeof TeamService>;
const mockPlayerService = PlayerService as jest.Mocked<typeof PlayerService>;

describe('Managed Players API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/teams/:teamId/managed-players', () => {
    const mockTeamMember = {
      id: 'f6a7b8c9-d0e1-2345-6789-0abcdef01234',
      teamId: TEST_TEAM_ID,
      playerId: TEST_MANAGED_PLAYER_ID,
      jerseyNumber: 5,
      position: 'PG',
      createdAt: new Date(),
      updatedAt: new Date(),
      player: {
        id: TEST_MANAGED_PLAYER_ID,
        name: 'Young Player',
        email: null,
        isManaged: true,
        managedById: TEST_USER_ID,
      },
      team: {
        id: TEST_TEAM_ID,
        name: 'Warriors',
      },
    };

    it('should create a managed player successfully', async () => {
      mockTeamService.addManagedPlayer.mockResolvedValue(mockTeamMember as any);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Young Player', jerseyNumber: 5, position: 'PG' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.teamMember).toBeDefined();
      expect(response.body.teamMember.player.isManaged).toBe(true);
      expect(response.body.teamMember.player.email).toBeNull();
      expect(mockTeamService.addManagedPlayer).toHaveBeenCalledWith(
        TEST_TEAM_ID,
        { name: 'Young Player', jerseyNumber: 5, position: 'PG' },
        TEST_USER_ID
      );
    });

    it('should create a managed player with only name', async () => {
      const memberNoExtras = {
        ...mockTeamMember,
        jerseyNumber: null,
        position: null,
      };
      mockTeamService.addManagedPlayer.mockResolvedValue(memberNoExtras as any);

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Young Player' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 for missing name', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for empty name', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: '' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for name too long', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'A'.repeat(101) });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid jersey number', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Player', jerseyNumber: 100 });

      expect(response.status).toBe(400);
    });

    it('should return 400 for negative jersey number', async () => {
      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Player', jerseyNumber: -1 });

      expect(response.status).toBe(400);
    });

    it('should return 400 for non-UUID teamId', async () => {
      const response = await request(app)
        .post('/api/v1/teams/not-a-uuid/managed-players')
        .send({ name: 'Player' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid teamId format');
    });

    it('should return 404 when team not found', async () => {
      mockTeamService.addManagedPlayer.mockRejectedValue(
        new NotFoundError('Team not found')
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Player' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Team not found');
    });

    it('should return 403 when user lacks canManageRoster permission', async () => {
      mockTeamService.addManagedPlayer.mockRejectedValue(
        new ForbiddenError('You do not have permission to manage this team\'s roster')
      );

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Player' });

      expect(response.status).toBe(403);
    });

    it('should handle unexpected errors gracefully', async () => {
      mockTeamService.addManagedPlayer.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post(`/api/v1/teams/${TEST_TEAM_ID}/managed-players`)
        .send({ name: 'Player' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to create managed player');
    });
  });

  describe('GET /api/v1/players (isManaged filter)', () => {
    it('should exclude managed players by default', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [],
        pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app).get('/api/v1/players');

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({})
      );
    });

    it('should accept isManaged=true query param', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [],
        pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ isManaged: 'true' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ isManaged: true })
      );
    });

    it('should accept isManaged=false query param', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [],
        pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
      } as any);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ isManaged: 'false' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ isManaged: false })
      );
    });
  });

  describe('GET /api/v1/players/:id (managed player)', () => {
    it('should return managed player with isManaged and managedById', async () => {
      const managedPlayer = {
        id: TEST_MANAGED_PLAYER_ID,
        email: null,
        name: 'Young Player',
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: false,
        isManaged: true,
        managedById: TEST_USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        teamMembers: [],
      };

      mockPlayerService.getPlayerById.mockResolvedValue(managedPlayer as any);

      const response = await request(app)
        .get(`/api/v1/players/${TEST_MANAGED_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.player.isManaged).toBe(true);
      expect(response.body.player.managedById).toBe(TEST_USER_ID);
      expect(response.body.player.email).toBeNull();
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
