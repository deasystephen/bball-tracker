/**
 * Unit tests for PlayerService
 */

import { PlayerService } from '../../src/services/player-service';
import { mockPrisma } from '../setup';
import {
  createPlayer,
  createCoach,
  createAdmin,
  createTeamMember,
  createTeam,
  createSeason,
  createLeague,
  createGameEvent,
} from '../factories';
import { expectNotFoundError, expectBadRequestError } from '../helpers';

describe('PlayerService', () => {
  describe('createPlayer', () => {
    it('should create a player successfully', async () => {
      const player = createPlayer({
        email: 'newplayer@test.com',
        name: 'New Player',
      });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user.create as jest.Mock).mockResolvedValue({
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: false,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
      });

      const result = await PlayerService.createPlayer(
        { email: 'newplayer@test.com', name: 'New Player' },
        'admin-id'
      );

      expect(result).toHaveProperty('id', player.id);
      expect(result).toHaveProperty('email', 'newplayer@test.com');
      expect(result).toHaveProperty('role', 'PLAYER');
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'newplayer@test.com',
            name: 'New Player',
            role: 'PLAYER',
          }),
        })
      );
    });

    it('should throw BadRequestError if email already exists', async () => {
      const existingPlayer = createPlayer({ email: 'existing@test.com' });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(existingPlayer);

      try {
        await PlayerService.createPlayer(
          { email: 'existing@test.com', name: 'New Player' },
          'admin-id'
        );
      } catch (error) {
        expectBadRequestError(error, 'A user with this email already exists');
      }
    });
  });

  describe('getPlayerById', () => {
    it('should return player with teams', async () => {
      const player = createPlayer();
      const league = createLeague();
      const season = createSeason({ leagueId: league.id });
      const team = createTeam({ seasonId: season.id });
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: true,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        teamMembers: [{
          ...member,
          team: {
            id: team.id,
            name: team.name,
            season: {
              id: season.id,
              name: season.name,
              league: {
                id: league.id,
                name: league.name,
              },
            },
          },
        }],
      });

      const result = await PlayerService.getPlayerById(player.id);

      expect(result).toHaveProperty('id', player.id);
      expect(result.teamMembers).toHaveLength(1);
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await PlayerService.getPlayerById('non-existent');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if user is not a player', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...coach,
        teamMembers: [],
      });

      try {
        await PlayerService.getPlayerById(coach.id);
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });
  });

  describe('listPlayers', () => {
    it('should return all players with pagination', async () => {
      const player1 = createPlayer({ name: 'Player 1' });
      const player2 = createPlayer({ name: 'Player 2' });

      (mockPrisma.user.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
        {
          id: player1.id,
          email: player1.email,
          name: player1.name,
          role: 'PLAYER',
          profilePictureUrl: null,
          emailVerified: true,
          createdAt: player1.createdAt,
          updatedAt: player1.updatedAt,
          _count: { teamMembers: 1 },
        },
        {
          id: player2.id,
          email: player2.email,
          name: player2.name,
          role: 'PLAYER',
          profilePictureUrl: null,
          emailVerified: true,
          createdAt: player2.createdAt,
          updatedAt: player2.updatedAt,
          _count: { teamMembers: 0 },
        },
      ]);

      const result = await PlayerService.listPlayers({ limit: 10, offset: 0 });

      expect(result.players).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('should filter by search term', async () => {
      const player = createPlayer({ name: 'John Doe', email: 'john@test.com' });

      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([{
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: true,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        _count: { teamMembers: 0 },
      }]);

      const result = await PlayerService.listPlayers({
        search: 'John',
        limit: 10,
        offset: 0,
      });

      expect(result.players).toHaveLength(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: expect.anything() }),
              expect.objectContaining({ email: expect.anything() }),
            ]),
          }),
        })
      );
    });

    it('should handle pagination correctly', async () => {
      const player = createPlayer();

      (mockPrisma.user.count as jest.Mock).mockResolvedValue(20);
      (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([{
        id: player.id,
        email: player.email,
        name: player.name,
        role: 'PLAYER',
        profilePictureUrl: null,
        emailVerified: true,
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
        _count: { teamMembers: 0 },
      }]);

      const result = await PlayerService.listPlayers({ limit: 10, offset: 0 });

      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.total).toBe(20);
    });
  });

  describe('updatePlayer', () => {
    it('should update player name (admin updating another player)', async () => {
      const player = createPlayer({ name: 'Old Name' });
      const adminUser = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)    // First call for player
        .mockResolvedValueOnce(adminUser); // Second call for current user (admin)
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...player,
        name: 'New Name',
      });

      const result = await PlayerService.updatePlayer(
        player.id,
        { name: 'New Name' },
        adminUser.id
      );

      expect(result).toHaveProperty('name', 'New Name');
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: player.id },
          data: expect.objectContaining({ name: 'New Name' }),
        })
      );
    });

    it('should allow player to update themselves', async () => {
      const player = createPlayer({ name: 'Old Name' });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player) // First call for player
        .mockResolvedValueOnce(player); // Second call for current user (same player)
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...player,
        name: 'New Name',
      });

      const result = await PlayerService.updatePlayer(
        player.id,
        { name: 'New Name' },
        player.id
      );

      expect(result).toHaveProperty('name', 'New Name');
    });

    it('should update player email', async () => {
      const player = createPlayer({ email: 'old@test.com' });
      const adminUser = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(null); // Check for existing email
      (mockPrisma.user.update as jest.Mock).mockResolvedValue({
        ...player,
        email: 'new@test.com',
      });

      const result = await PlayerService.updatePlayer(
        player.id,
        { email: 'new@test.com' },
        adminUser.id
      );

      expect(result).toHaveProperty('email', 'new@test.com');
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      try {
        await PlayerService.updatePlayer('non-existent', { name: 'New Name' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if user is not a player', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(coach);

      try {
        await PlayerService.updatePlayer(coach.id, { name: 'New Name' }, 'user-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw ForbiddenError when non-admin updates another player', async () => {
      const player = createPlayer({ email: 'player@test.com' });
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(coach); // non-admin, different user

      try {
        await PlayerService.updatePlayer(
          player.id,
          { name: 'Hacked Name' },
          coach.id
        );
        fail('Expected ForbiddenError');
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe('You can only update your own profile');
      }
    });

    it('should throw BadRequestError if email is already taken', async () => {
      const player = createPlayer({ email: 'old@test.com' });
      const existingPlayer = createPlayer({ email: 'existing@test.com' });
      const adminUser = createAdmin();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(player)
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(existingPlayer); // Existing user with email

      try {
        await PlayerService.updatePlayer(
          player.id,
          { email: 'existing@test.com' },
          adminUser.id
        );
      } catch (error) {
        expectBadRequestError(error, 'A user with this email already exists');
      }
    });
  });

  describe('deletePlayer', () => {
    const adminUser = { id: 'admin-id', role: 'ADMIN', email: 'admin@test.com', name: 'Admin' };

    it('should delete player successfully', async () => {
      const player = createPlayer();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser) // admin check
        .mockResolvedValueOnce({          // player lookup
          ...player,
          teamMembers: [],
          gameEvents: [],
        });
      (mockPrisma.user.delete as jest.Mock).mockResolvedValue(player);

      const result = await PlayerService.deletePlayer(player.id, 'admin-id');

      expect(result).toEqual({ success: true });
      expect(mockPrisma.user.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: player.id },
        })
      );
    });

    it('should throw NotFoundError if admin user does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);

      try {
        await PlayerService.deletePlayer('non-existent', 'admin-id');
      } catch (error) {
        expectNotFoundError(error, 'User not found');
      }
    });

    it('should throw NotFoundError if player does not exist', async () => {
      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce(null);       // player not found

      try {
        await PlayerService.deletePlayer('non-existent', 'admin-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw NotFoundError if user is not a player', async () => {
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce({           // coach (not player role)
          ...coach,
          teamMembers: [],
          gameEvents: [],
        });

      try {
        await PlayerService.deletePlayer(coach.id, 'admin-id');
      } catch (error) {
        expectNotFoundError(error, 'Player not found');
      }
    });

    it('should throw BadRequestError if player is on teams', async () => {
      const player = createPlayer();
      const team = createTeam();
      const member = createTeamMember({ teamId: team.id, playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce({           // player with teams
          ...player,
          teamMembers: [member],
          gameEvents: [],
        });

      try {
        await PlayerService.deletePlayer(player.id, 'admin-id');
      } catch (error) {
        expectBadRequestError(
          error,
          'Cannot delete player who is currently on teams. Remove player from all teams first.'
        );
      }
    });

    it('should throw BadRequestError if player has game events', async () => {
      const player = createPlayer();
      const event = createGameEvent({ playerId: player.id });

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(adminUser)  // admin check
        .mockResolvedValueOnce({           // player with events
          ...player,
          teamMembers: [],
          gameEvents: [event],
        });

      try {
        await PlayerService.deletePlayer(player.id, 'admin-id');
      } catch (error) {
        expectBadRequestError(
          error,
          'Cannot delete player with game history. Player data must be preserved for statistics.'
        );
      }
    });

    it('should throw ForbiddenError for non-admin users', async () => {
      const player = createPlayer();
      const coach = createCoach();

      (mockPrisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(coach);  // non-admin user

      try {
        await PlayerService.deletePlayer(player.id, coach.id);
        fail('Expected ForbiddenError');
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe('Only administrators can delete players');
      }
    });
  });
});
