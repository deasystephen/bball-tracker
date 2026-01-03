/**
 * React Query hooks for Leagues API
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

// Types
export interface League {
  id: string;
  name: string;
  season: string;
  year: number;
  createdAt: string;
  updatedAt: string;
  teams?: Array<{
    id: string;
    name: string;
  }>;
}

// Query keys
export const leagueKeys = {
  all: ['leagues'] as const,
  lists: () => [...leagueKeys.all, 'list'] as const,
  list: (filters?: { year?: number; season?: string }) =>
    [...leagueKeys.lists(), filters] as const,
  details: () => [...leagueKeys.all, 'detail'] as const,
  detail: (id: string) => [...leagueKeys.details(), id] as const,
};

// Hooks
export function useLeagues(filters?: { year?: number; season?: string }) {
  return useQuery({
    queryKey: leagueKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.year) params.append('year', filters.year.toString());
      if (filters?.season) params.append('season', filters.season);

      const response = await apiClient.get(`/leagues?${params.toString()}`);
      return response.data.leagues as League[];
    },
  });
}

export function useLeague(leagueId: string) {
  return useQuery({
    queryKey: leagueKeys.detail(leagueId),
    queryFn: async () => {
      const response = await apiClient.get(`/leagues/${leagueId}`);
      return response.data.league as League;
    },
    enabled: !!leagueId,
  });
}
