/**
 * Tests for usePlayers hooks
 *
 * Tests query key generation and data types.
 */

import {
  playerKeys,
  Player,
  CreatePlayerInput,
  UpdatePlayerInput,
  PlayersQueryParams,
} from '../../hooks/usePlayers';

describe('usePlayers', () => {
  describe('playerKeys', () => {
    it('should generate base key correctly', () => {
      expect(playerKeys.all).toEqual(['players']);
    });

    it('should generate lists key correctly', () => {
      expect(playerKeys.lists()).toEqual(['players', 'list']);
    });

    it('should generate list key with no params', () => {
      expect(playerKeys.list()).toEqual(['players', 'list', undefined]);
    });

    it('should generate list key with search param', () => {
      expect(playerKeys.list({ search: 'John' })).toEqual([
        'players',
        'list',
        { search: 'John' },
      ]);
    });

    it('should generate list key with role param', () => {
      expect(playerKeys.list({ role: 'PLAYER' })).toEqual([
        'players',
        'list',
        { role: 'PLAYER' },
      ]);
    });

    it('should generate list key with pagination params', () => {
      expect(playerKeys.list({ limit: 20, offset: 10 })).toEqual([
        'players',
        'list',
        { limit: 20, offset: 10 },
      ]);
    });

    it('should generate list key with all params', () => {
      const params: PlayersQueryParams = {
        search: 'John',
        role: 'COACH',
        limit: 10,
        offset: 0,
      };
      expect(playerKeys.list(params)).toEqual(['players', 'list', params]);
    });

    it('should generate details key correctly', () => {
      expect(playerKeys.details()).toEqual(['players', 'detail']);
    });

    it('should generate detail key for specific player', () => {
      expect(playerKeys.detail('player-123')).toEqual([
        'players',
        'detail',
        'player-123',
      ]);
    });
  });

  describe('Player type', () => {
    const basePlayer: Player = {
      id: 'player-1',
      email: 'john@example.com',
      name: 'John Doe',
      role: 'PLAYER',
      profilePictureUrl: null,
      emailVerified: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('should accept valid player object', () => {
      expect(basePlayer.id).toBe('player-1');
      expect(basePlayer.name).toBe('John Doe');
      expect(basePlayer.email).toBe('john@example.com');
    });

    it('should accept all valid role values', () => {
      const roles: Player['role'][] = ['PLAYER', 'COACH', 'PARENT', 'ADMIN'];

      roles.forEach((role) => {
        const player: Player = { ...basePlayer, role };
        expect(player.role).toBe(role);
      });
    });

    it('should accept player with profile picture', () => {
      const player: Player = {
        ...basePlayer,
        profilePictureUrl: 'https://example.com/photo.jpg',
      };
      expect(player.profilePictureUrl).toBe('https://example.com/photo.jpg');
    });

    it('should accept player with team members', () => {
      const player: Player = {
        ...basePlayer,
        teamMembers: [
          {
            id: 'tm-1',
            team: {
              id: 'team-1',
              name: 'Lakers',
              league: {
                id: 'league-1',
                name: 'Spring League',
                season: 'Spring',
                year: 2024,
              },
            },
          },
        ],
      };

      expect(player.teamMembers).toHaveLength(1);
      expect(player.teamMembers?.[0].team.name).toBe('Lakers');
    });

    it('should accept player with team count', () => {
      const player: Player = {
        ...basePlayer,
        _count: {
          teamMembers: 3,
        },
      };

      expect(player._count?.teamMembers).toBe(3);
    });

    it('should have required fields', () => {
      expect(typeof basePlayer.id).toBe('string');
      expect(typeof basePlayer.email).toBe('string');
      expect(typeof basePlayer.name).toBe('string');
      expect(typeof basePlayer.role).toBe('string');
      expect(typeof basePlayer.emailVerified).toBe('boolean');
      expect(typeof basePlayer.createdAt).toBe('string');
      expect(typeof basePlayer.updatedAt).toBe('string');
    });
  });

  describe('CreatePlayerInput type', () => {
    it('should accept minimal input', () => {
      const input: CreatePlayerInput = {
        email: 'newplayer@example.com',
        name: 'New Player',
      };

      expect(input.email).toBe('newplayer@example.com');
      expect(input.name).toBe('New Player');
    });

    it('should accept input with profile picture', () => {
      const input: CreatePlayerInput = {
        email: 'newplayer@example.com',
        name: 'New Player',
        profilePictureUrl: 'https://example.com/photo.jpg',
      };

      expect(input.profilePictureUrl).toBe('https://example.com/photo.jpg');
    });
  });

  describe('UpdatePlayerInput type', () => {
    it('should accept partial update with name only', () => {
      const input: UpdatePlayerInput = {
        name: 'Updated Name',
      };
      expect(input.name).toBe('Updated Name');
    });

    it('should accept partial update with email only', () => {
      const input: UpdatePlayerInput = {
        email: 'newemail@example.com',
      };
      expect(input.email).toBe('newemail@example.com');
    });

    it('should accept partial update with profile picture only', () => {
      const input: UpdatePlayerInput = {
        profilePictureUrl: 'https://example.com/newphoto.jpg',
      };
      expect(input.profilePictureUrl).toBe('https://example.com/newphoto.jpg');
    });

    it('should accept complete update', () => {
      const input: UpdatePlayerInput = {
        name: 'New Name',
        email: 'newemail@example.com',
        profilePictureUrl: 'https://example.com/photo.jpg',
      };

      expect(input.name).toBe('New Name');
      expect(input.email).toBe('newemail@example.com');
      expect(input.profilePictureUrl).toBe('https://example.com/photo.jpg');
    });
  });

  describe('PlayersQueryParams type', () => {
    it('should accept search param', () => {
      const params: PlayersQueryParams = {
        search: 'John',
      };
      expect(params.search).toBe('John');
    });

    it('should accept role param', () => {
      const params: PlayersQueryParams = {
        role: 'COACH',
      };
      expect(params.role).toBe('COACH');
    });

    it('should accept pagination params', () => {
      const params: PlayersQueryParams = {
        limit: 20,
        offset: 40,
      };
      expect(params.limit).toBe(20);
      expect(params.offset).toBe(40);
    });

    it('should accept all params together', () => {
      const params: PlayersQueryParams = {
        search: 'Smith',
        role: 'ADMIN',
        limit: 50,
        offset: 0,
      };

      expect(params.search).toBe('Smith');
      expect(params.role).toBe('ADMIN');
      expect(params.limit).toBe(50);
      expect(params.offset).toBe(0);
    });
  });
});
