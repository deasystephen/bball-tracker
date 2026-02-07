/**
 * React Query hooks for Stats API
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import type {
  BoxScore,
  PlayerGameStats,
  AggregatedPlayerStats,
  TeamSeasonStats,
  PlayerOverallStats,
} from '../types/stats';

// Query keys
export const statsKeys = {
  all: ['stats'] as const,
  boxScores: () => [...statsKeys.all, 'boxScore'] as const,
  boxScore: (gameId: string) => [...statsKeys.boxScores(), gameId] as const,
  playerGame: (gameId: string, playerId: string) =>
    [...statsKeys.all, 'playerGame', gameId, playerId] as const,
  playerOverall: (playerId: string) =>
    [...statsKeys.all, 'playerOverall', playerId] as const,
  playerSeason: (playerId: string, teamId: string) =>
    [...statsKeys.all, 'playerSeason', playerId, teamId] as const,
  teamSeason: (teamId: string) => [...statsKeys.all, 'teamSeason', teamId] as const,
  teamRoster: (teamId: string) => [...statsKeys.all, 'teamRoster', teamId] as const,
};

// Longer stale time for stats since they only change when games end
const STATS_STALE_TIME = 10 * 60 * 1000; // 10 minutes

/**
 * Hook to fetch box score for a game
 */
export function useBoxScore(gameId: string) {
  return useQuery({
    queryKey: statsKeys.boxScore(gameId),
    queryFn: async () => {
      const response = await apiClient.get(`/stats/games/${gameId}`);
      return response.data.boxScore as BoxScore;
    },
    enabled: !!gameId,
    staleTime: STATS_STALE_TIME,
  });
}

/**
 * Hook to fetch a player's stats for a specific game
 */
export function usePlayerGameStats(gameId: string, playerId: string) {
  return useQuery({
    queryKey: statsKeys.playerGame(gameId, playerId),
    queryFn: async () => {
      const response = await apiClient.get(`/stats/games/${gameId}/players/${playerId}`);
      return response.data.stats as PlayerGameStats;
    },
    enabled: !!gameId && !!playerId,
    staleTime: STATS_STALE_TIME,
  });
}

/**
 * Hook to fetch a player's overall stats across all teams
 */
export function usePlayerOverallStats(playerId: string) {
  return useQuery({
    queryKey: statsKeys.playerOverall(playerId),
    queryFn: async () => {
      const response = await apiClient.get(`/stats/players/${playerId}`);
      return {
        player: response.data.player,
        teams: response.data.teams,
        careerTotals: response.data.careerTotals,
      } as PlayerOverallStats;
    },
    enabled: !!playerId,
    staleTime: STATS_STALE_TIME,
  });
}

/**
 * Hook to fetch a player's season stats for a specific team
 */
export function usePlayerSeasonStats(playerId: string, teamId: string) {
  return useQuery({
    queryKey: statsKeys.playerSeason(playerId, teamId),
    queryFn: async () => {
      const response = await apiClient.get(`/stats/players/${playerId}/teams/${teamId}`);
      return response.data.stats as AggregatedPlayerStats;
    },
    enabled: !!playerId && !!teamId,
    staleTime: STATS_STALE_TIME,
  });
}

/**
 * Hook to fetch team's season stats
 */
export function useTeamSeasonStats(teamId: string) {
  return useQuery({
    queryKey: statsKeys.teamSeason(teamId),
    queryFn: async () => {
      const response = await apiClient.get(`/stats/teams/${teamId}`);
      return response.data.stats as TeamSeasonStats;
    },
    enabled: !!teamId,
    staleTime: STATS_STALE_TIME,
  });
}

/**
 * Hook to fetch team roster with player season stats
 */
export function useTeamRosterStats(teamId: string) {
  return useQuery({
    queryKey: statsKeys.teamRoster(teamId),
    queryFn: async () => {
      const response = await apiClient.get(`/stats/teams/${teamId}/players`);
      return response.data.players as AggregatedPlayerStats[];
    },
    enabled: !!teamId,
    staleTime: STATS_STALE_TIME,
  });
}
