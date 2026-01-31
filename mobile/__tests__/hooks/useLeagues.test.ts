/**
 * Tests for useLeagues hooks
 *
 * Tests query key generation and data types.
 */

import { leagueKeys, League, LeagueFilters } from '../../hooks/useLeagues';

describe('useLeagues', () => {
  describe('leagueKeys', () => {
    it('should generate base key correctly', () => {
      expect(leagueKeys.all).toEqual(['leagues']);
    });

    it('should generate lists key correctly', () => {
      expect(leagueKeys.lists()).toEqual(['leagues', 'list']);
    });

    it('should generate list key with no filters', () => {
      expect(leagueKeys.list()).toEqual(['leagues', 'list', undefined]);
    });

    it('should generate list key with search filter', () => {
      expect(leagueKeys.list({ search: 'Spring' })).toEqual([
        'leagues',
        'list',
        { search: 'Spring' },
      ]);
    });

    it('should generate list key with limit filter', () => {
      expect(leagueKeys.list({ limit: 10 })).toEqual([
        'leagues',
        'list',
        { limit: 10 },
      ]);
    });

    it('should generate list key with multiple filters', () => {
      const filters: LeagueFilters = { search: 'Spring', limit: 10, offset: 0 };
      expect(leagueKeys.list(filters)).toEqual([
        'leagues',
        'list',
        filters,
      ]);
    });

    it('should generate details key correctly', () => {
      expect(leagueKeys.details()).toEqual(['leagues', 'detail']);
    });

    it('should generate detail key for specific league', () => {
      expect(leagueKeys.detail('league-123')).toEqual([
        'leagues',
        'detail',
        'league-123',
      ]);
    });
  });

  describe('League type', () => {
    it('should accept valid league object', () => {
      const league: League = {
        id: 'league-1',
        name: 'Downtown Youth Basketball',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(league.id).toBe('league-1');
      expect(league.name).toBe('Downtown Youth Basketball');
    });

    it('should accept league with optional seasons', () => {
      const league: League = {
        id: 'league-1',
        name: 'Downtown Youth Basketball',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        seasons: [
          { id: 'season-1', name: 'Spring 2024', isActive: true },
          { id: 'season-2', name: 'Fall 2023', isActive: false },
        ],
      };

      expect(league.seasons).toHaveLength(2);
      expect(league.seasons?.[0].name).toBe('Spring 2024');
    });

    it('should accept league without seasons', () => {
      const league: League = {
        id: 'league-1',
        name: 'Downtown Youth Basketball',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      expect(league.seasons).toBeUndefined();
    });

    it('should accept league with _count', () => {
      const league: League = {
        id: 'league-1',
        name: 'Downtown Youth Basketball',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        _count: {
          seasons: 3,
        },
      };

      expect(league._count?.seasons).toBe(3);
    });

    it('should have required fields', () => {
      const league: League = {
        id: 'league-1',
        name: 'Fall League',
        createdAt: '2023-09-01T00:00:00Z',
        updatedAt: '2023-09-01T00:00:00Z',
      };

      expect(typeof league.id).toBe('string');
      expect(typeof league.name).toBe('string');
      expect(typeof league.createdAt).toBe('string');
      expect(typeof league.updatedAt).toBe('string');
    });
  });
});
