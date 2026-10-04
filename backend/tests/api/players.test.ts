/**
 * Players API Integration Tests
 */

import request from 'supertest';
import { app, httpServer } from '../../src/index';
import { PlayerService } from '../../src/services/player-service';
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../../src/utils/errors';
import { authenticate } from '../../src/api/auth/middleware';

// Test UUIDs
const TEST_PLAYER_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

// Mock the authenticate middleware
jest.mock('../../src/api/auth/middleware', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.user = {
      id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef',
      email: 'test@example.com',
      name: 'Test User',
      role: 'COACH',
    };
    next();
  }),
}));

// Mock the service
jest.mock('../../src/services/player-service');

const mockPlayerService = PlayerService as jest.Mocked<typeof PlayerService>;
const mockAuthenticate = authenticate as jest.Mock;

const GUARDIAN_ID = 'c3d4e5f6-a7b8-4012-8456-7890abcdef01';
const LEAGUE_ADMIN_ID = 'd4e5f6a7-b8c9-4123-9567-890abcdef012';

/** The next request authenticates as this caller instead of the default COACH. */
function asCaller(id: string, role: string): void {
  mockAuthenticate.mockImplementationOnce((req, _res, next) => {
    req.user = { id, email: `${role.toLowerCase()}@example.com`, name: role, role };
    next();
  });
}

describe('Players API', () => {
  const mockPlayer = {
    id: TEST_PLAYER_ID,
    email: 'player@example.com',
    name: 'John Player',
    role: 'PLAYER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/players', () => {
    it('should create a player successfully', async () => {
      mockPlayerService.createPlayer.mockResolvedValue(mockPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.createPlayer>>);

      const response = await request(app)
        .post('/api/v1/players')
        .send({
          email: 'player@example.com',
          name: 'John Player',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.player).toBeDefined();
      expect(mockPlayerService.createPlayer).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'player@example.com', name: 'John Player' }),
        { id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef', role: 'COACH' }
      );
    });

    it('stores the address in its normalised form: trimmed and lower-cased (#651)', async () => {
      mockPlayerService.createPlayer.mockResolvedValue(mockPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.createPlayer>>);

      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: '  Jordan.Smith@Example.com ', name: 'Jordan' });

      expect(response.status).toBe(201);
      expect(mockPlayerService.createPlayer).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'jordan.smith@example.com' }),
        expect.anything()
      );
    });

    it('answers 400 when the address is already taken in another case (#651)', async () => {
      mockPlayerService.createPlayer.mockRejectedValue(new BadRequestError('A user with this email already exists'));

      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'Jordan@Example.com', name: 'Jordan' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('A user with this email already exists');
    });

    it('rejects an address longer than 255 characters (#651)', async () => {
      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: `${'a'.repeat(250)}@example.com`, name: 'Long' });

      expect(response.status).toBe(400);
      expect(mockPlayerService.createPlayer).not.toHaveBeenCalled();
    });

    it('should return 403 when the caller may not create players (audit #2)', async () => {
      mockPlayerService.createPlayer.mockRejectedValue(new ForbiddenError('Only administrators and team staff who manage a roster can create players'));

      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'victim@example.com', name: 'Victim' });

      expect(response.status).toBe(403);
    });

    it('should return 409 when the email is taken concurrently', async () => {
      mockPlayerService.createPlayer.mockRejectedValue(new ConflictError('A user with this email already exists'));

      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'player@example.com', name: 'John Player' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('A user with this email already exists');
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'player@example.com' }); // Missing name

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should return 400 for invalid email', async () => {
      const response = await request(app)
        .post('/api/v1/players')
        .send({ email: 'invalid-email', name: 'John Player' });

      expect(response.status).toBe(400);
    });

    it('should handle service errors', async () => {
      mockPlayerService.createPlayer.mockRejectedValue(
        new BadRequestError('Player with this email already exists')
      );

      const response = await request(app)
        .post('/api/v1/players')
        .send({
          email: 'player@example.com',
          name: 'John Player',
        });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/players', () => {
    it('should list players successfully', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockPlayerService.listPlayers>>);

      const response = await request(app).get('/api/v1/players');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.players).toHaveLength(1);
      expect(response.body.pagination).toBeDefined();
    });

    it('should support search query', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockPlayerService.listPlayers>>);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ search: 'John' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'John' }),
        { id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef', role: 'COACH' }
      );
    });

    it('passes a league admin through to the directory scope (#685)', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockPlayerService.listPlayers>>);
      asCaller(LEAGUE_ADMIN_ID, 'COACH');

      const response = await request(app).get('/api/v1/players').query({ search: 'John' });

      expect(response.status).toBe(200);
      expect(response.body.players).toHaveLength(1);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'John' }),
        { id: LEAGUE_ADMIN_ID, role: 'COACH' }
      );
    });

    it('passes a guardian through to the directory scope (#685)', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockPlayerService.listPlayers>>);
      asCaller(GUARDIAN_ID, 'PARENT');

      const response = await request(app).get('/api/v1/players');

      expect(response.status).toBe(200);
      expect(response.body.players).toHaveLength(1);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(expect.anything(), { id: GUARDIAN_ID, role: 'PARENT' });
    });

    it('should filter by role', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 1, limit: 10, offset: 0, hasMore: false },
      } as unknown as Awaited<ReturnType<typeof mockPlayerService.listPlayers>>);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ role: 'PLAYER' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.listPlayers).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'PLAYER' }),
        expect.objectContaining({ role: 'COACH' })
      );
    });

    it('should support pagination', async () => {
      mockPlayerService.listPlayers.mockResolvedValue({
        players: [mockPlayer],
        pagination: { total: 25, limit: 10, offset: 10, hasMore: true },
      } as unknown as Awaited<ReturnType<typeof mockPlayerService.listPlayers>>);

      const response = await request(app)
        .get('/api/v1/players')
        .query({ limit: 10, offset: 10 });

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /api/v1/players/:id', () => {
    it('should get a player by ID', async () => {
      mockPlayerService.getPlayerById.mockResolvedValue(mockPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.getPlayerById>>);

      const response = await request(app).get(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.player.id).toBe(TEST_PLAYER_ID);
      // The caller's identity is passed through so the service can scope access (audit #3)
      expect(mockPlayerService.getPlayerById).toHaveBeenCalledWith(
        TEST_PLAYER_ID,
        { id: 'a1b2c3d4-e5f6-4890-a234-567890abcdef', role: 'COACH' }
      );
    });

    it('returns the child to a guardian (#685)', async () => {
      mockPlayerService.getPlayerById.mockResolvedValue({ ...mockPlayer, email: null } as unknown as Awaited<ReturnType<typeof mockPlayerService.getPlayerById>>);
      asCaller(GUARDIAN_ID, 'PARENT');

      const response = await request(app).get(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.player.id).toBe(TEST_PLAYER_ID);
      expect(response.body.player.email).toBeNull();
      expect(mockPlayerService.getPlayerById).toHaveBeenCalledWith(TEST_PLAYER_ID, { id: GUARDIAN_ID, role: 'PARENT' });
    });

    it('returns a player on a team in the league to a league admin who is not staff (#685)', async () => {
      mockPlayerService.getPlayerById.mockResolvedValue({ ...mockPlayer, email: null } as unknown as Awaited<ReturnType<typeof mockPlayerService.getPlayerById>>);
      asCaller(LEAGUE_ADMIN_ID, 'COACH');

      const response = await request(app).get(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(mockPlayerService.getPlayerById).toHaveBeenCalledWith(TEST_PLAYER_ID, { id: LEAGUE_ADMIN_ID, role: 'COACH' });
    });

    it('should return 404 for non-existent player', async () => {
      mockPlayerService.getPlayerById.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app).get('/api/v1/players/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Player not found');
    });
  });

  describe('PATCH /api/v1/players/:id', () => {
    it('should update a player successfully', async () => {
      const updatedPlayer = { ...mockPlayer, name: 'Updated Name' };
      mockPlayerService.updatePlayer.mockResolvedValue(updatedPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.updatePlayer>>);

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.player.name).toBe('Updated Name');
    });

    it('should return 400 for empty name', async () => {
      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: '' }); // Empty name

      expect(response.status).toBe(400);
    });

    it('should return 404 for non-existent player', async () => {
      mockPlayerService.updatePlayer.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app)
        .patch('/api/v1/players/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(404);
    });

    it('returns 404 for a deleted account (tombstone), even for an admin (#643)', async () => {
      mockPlayerService.updatePlayer.mockRejectedValue(new NotFoundError('Player not found'));
      asCaller('e5f6a7b8-c9d0-4234-8678-90abcdef0123', 'ADMIN');

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: 'Jordan Lee', email: 'jordan@example.org' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Player not found');
    });

    it('passes a mixed-case address to the service lower-cased (#651)', async () => {
      mockPlayerService.updatePlayer.mockResolvedValue(mockPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.updatePlayer>>);

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ email: ' Jordan.Smith@Example.com' });

      expect(response.status).toBe(200);
      expect(mockPlayerService.updatePlayer).toHaveBeenCalledWith(
        TEST_PLAYER_ID,
        expect.objectContaining({ email: 'jordan.smith@example.com' }),
        'a1b2c3d4-e5f6-4890-a234-567890abcdef'
      );
    });

    it('should return 403 for unauthorized update', async () => {
      mockPlayerService.updatePlayer.mockRejectedValue(
        new ForbiddenError('Not authorized to update this player')
      );

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
    });

    it('should return 409 when an email update races another account', async () => {
      mockPlayerService.updatePlayer.mockRejectedValue(new ConflictError('A user with this email already exists'));

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ email: 'taken@example.com' });

      expect(response.status).toBe(409);
    });

    it('should update player with valid profilePictureUrl', async () => {
      const updatedPlayer = {
        ...mockPlayer,
        profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/user/photo.jpg',
      };
      mockPlayerService.updatePlayer.mockResolvedValue(updatedPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.updatePlayer>>);

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/user/photo.jpg' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.player.profilePictureUrl).toBe(
        'https://bucket.s3.amazonaws.com/avatars/user/photo.jpg'
      );
    });

    it('should accept empty string profilePictureUrl to clear avatar', async () => {
      const updatedPlayer = { ...mockPlayer, profilePictureUrl: '' };
      mockPlayerService.updatePlayer.mockResolvedValue(updatedPlayer as unknown as Awaited<ReturnType<typeof mockPlayerService.updatePlayer>>);

      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ profilePictureUrl: '' });

      expect(response.status).toBe(200);
    });

    it('should reject javascript: URI for profilePictureUrl', async () => {
      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ profilePictureUrl: 'javascript:alert(1)' });

      expect(response.status).toBe(400);
    });

    it('should reject invalid URL for profilePictureUrl', async () => {
      const response = await request(app)
        .patch(`/api/v1/players/${TEST_PLAYER_ID}`)
        .send({ profilePictureUrl: 'not-a-valid-url' });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/players/:id', () => {
    it('should delete a player successfully', async () => {
      mockPlayerService.deletePlayer.mockResolvedValue({ success: true });

      const response = await request(app).delete(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Player deleted successfully');
    });

    it('should return 404 for non-existent player', async () => {
      mockPlayerService.deletePlayer.mockRejectedValue(
        new NotFoundError('Player not found')
      );

      const response = await request(app).delete('/api/v1/players/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
    });

    it('returns 404 for a deleted account (tombstone) (#643)', async () => {
      mockPlayerService.deletePlayer.mockRejectedValue(new NotFoundError('Player not found'));

      const response = await request(app).delete(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Player not found');
    });

    it('should return 403 for unauthorized delete', async () => {
      mockPlayerService.deletePlayer.mockRejectedValue(
        new ForbiddenError('Not authorized to delete this player')
      );

      const response = await request(app).delete(`/api/v1/players/${TEST_PLAYER_ID}`);

      expect(response.status).toBe(403);
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
