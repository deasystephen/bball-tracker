/**
 * Tests for useTeams hooks
 *
 * Tests query key generation and data types.
 * Integration tests with actual React Query would require
 * more complex test setup with proper provider wrappers.
 */

import {
  teamKeys,
  Team,
  CreateTeamInput,
  UpdateTeamInput,
  AddPlayerInput,
  TeamFilters,
} from '../../hooks/useTeams';

describe('useTeams', () => {
  describe('teamKeys', () => {
    it('should generate base key correctly', () => {
      expect(teamKeys.all).toEqual(['teams']);
    });

    it('should generate lists key correctly', () => {
      expect(teamKeys.lists()).toEqual(['teams', 'list']);
    });

    it('should generate list key with no filters', () => {
      expect(teamKeys.list()).toEqual(['teams', 'list', undefined]);
    });

    it('should generate list key with seasonId filter', () => {
      expect(teamKeys.list({ seasonId: 'season-1' })).toEqual([
        'teams',
        'list',
        { seasonId: 'season-1' },
      ]);
    });

    it('should generate list key with leagueId filter', () => {
      expect(teamKeys.list({ leagueId: 'league-1' })).toEqual([
        'teams',
        'list',
        { leagueId: 'league-1' },
      ]);
    });

    it('should generate list key with multiple filters', () => {
      const filters: TeamFilters = { seasonId: 'season-1', leagueId: 'league-1' };
      expect(teamKeys.list(filters)).toEqual([
        'teams',
        'list',
        filters,
      ]);
    });

    it('should generate details key correctly', () => {
      expect(teamKeys.details()).toEqual(['teams', 'detail']);
    });

    it('should generate detail key for specific team', () => {
      expect(teamKeys.detail('team-123')).toEqual(['teams', 'detail', 'team-123']);
    });
  });

  describe('Team type', () => {
    it('should accept valid team object', () => {
      const team: Team = {
        id: 'team-1',
        name: 'Lakers',
        seasonId: 'season-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(team.id).toBe('team-1');
      expect(team.name).toBe('Lakers');
    });

    it('should accept team with optional season', () => {
      const team: Team = {
        id: 'team-1',
        name: 'Lakers',
        seasonId: 'season-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        season: {
          id: 'season-1',
          name: 'Spring 2024',
          isActive: true,
          league: {
            id: 'league-1',
            name: 'Downtown Youth Basketball',
          },
        },
      };

      expect(team.season?.name).toBe('Spring 2024');
      expect(team.season?.league.name).toBe('Downtown Youth Basketball');
    });

    it('should accept team with staff', () => {
      const team: Team = {
        id: 'team-1',
        name: 'Lakers',
        seasonId: 'season-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        staff: [
          {
            id: 'staff-1',
            userId: 'user-1',
            user: {
              id: 'user-1',
              name: 'Coach Smith',
              email: 'coach@example.com',
            },
            role: {
              id: 'role-1',
              name: 'Head Coach',
              type: 'HEAD_COACH',
              canManageTeam: true,
              canManageRoster: true,
              canTrackStats: true,
              canViewStats: true,
              canShareStats: true,
            },
          },
        ],
      };

      expect(team.staff?.[0].user.name).toBe('Coach Smith');
      expect(team.staff?.[0].role.type).toBe('HEAD_COACH');
    });

    it('should accept team with members', () => {
      const team: Team = {
        id: 'team-1',
        name: 'Lakers',
        seasonId: 'season-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        members: [
          {
            id: 'member-1',
            playerId: 'player-1',
            jerseyNumber: 23,
            position: 'Guard',
            player: {
              id: 'player-1',
              name: 'John Doe',
              email: 'john@example.com',
            },
          },
        ],
      };

      expect(team.members?.[0].jerseyNumber).toBe(23);
    });
  });

  describe('CreateTeamInput type', () => {
    it('should accept minimal input', () => {
      const input: CreateTeamInput = {
        name: 'New Team',
        seasonId: 'season-1',
      };

      expect(input.name).toBe('New Team');
      expect(input.seasonId).toBe('season-1');
    });
  });

  describe('UpdateTeamInput type', () => {
    it('should accept partial update with name only', () => {
      const input: UpdateTeamInput = {
        name: 'Updated Team',
      };

      expect(input.name).toBe('Updated Team');
    });

    it('should accept partial update with seasonId only', () => {
      const input: UpdateTeamInput = {
        seasonId: 'new-season',
      };

      expect(input.seasonId).toBe('new-season');
    });

    it('should accept complete update', () => {
      const input: UpdateTeamInput = {
        name: 'Updated Team',
        seasonId: 'new-season',
      };

      expect(input.name).toBe('Updated Team');
      expect(input.seasonId).toBe('new-season');
    });
  });

  describe('AddPlayerInput type', () => {
    it('should accept minimal input with playerId', () => {
      const input: AddPlayerInput = {
        playerId: 'player-1',
      };

      expect(input.playerId).toBe('player-1');
    });

    it('should accept input with jersey number', () => {
      const input: AddPlayerInput = {
        playerId: 'player-1',
        jerseyNumber: 23,
      };

      expect(input.jerseyNumber).toBe(23);
    });

    it('should accept input with position', () => {
      const input: AddPlayerInput = {
        playerId: 'player-1',
        position: 'Guard',
      };

      expect(input.position).toBe('Guard');
    });

    it('should accept complete input', () => {
      const input: AddPlayerInput = {
        playerId: 'player-1',
        jerseyNumber: 23,
        position: 'Point Guard',
      };

      expect(input.playerId).toBe('player-1');
      expect(input.jerseyNumber).toBe(23);
      expect(input.position).toBe('Point Guard');
    });
  });
});
