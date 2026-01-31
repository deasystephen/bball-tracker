/**
 * React Query hooks for Seasons API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

// Types
export interface Season {
  id: string;
  leagueId: string;
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  league?: {
    id: string;
    name: string;
  };
  teams?: Array<{
    id: string;
    name: string;
  }>;
  _count?: {
    teams: number;
  };
}

export interface CreateSeasonInput {
  leagueId: string;
  name: string;
  startDate?: string;
  endDate?: string;
}

export interface UpdateSeasonInput {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
  isActive?: boolean;
}

export interface SeasonFilters {
  leagueId?: string;
  isActive?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface SeasonsResponse {
  success: boolean;
  seasons: Season[];
  total: number;
  limit: number;
  offset: number;
}

// Query keys
export const seasonKeys = {
  all: ['seasons'] as const,
  lists: () => [...seasonKeys.all, 'list'] as const,
  list: (filters?: SeasonFilters) => [...seasonKeys.lists(), filters] as const,
  details: () => [...seasonKeys.all, 'detail'] as const,
  detail: (id: string) => [...seasonKeys.details(), id] as const,
};

// Hooks
export function useSeasons(filters?: SeasonFilters) {
  return useQuery({
    queryKey: seasonKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.leagueId) params.append('leagueId', filters.leagueId);
      if (filters?.isActive !== undefined) params.append('isActive', String(filters.isActive));
      if (filters?.search) params.append('search', filters.search);
      if (filters?.limit) params.append('limit', String(filters.limit));
      if (filters?.offset) params.append('offset', String(filters.offset));

      const response = await apiClient.get<SeasonsResponse>(`/seasons?${params.toString()}`);
      return response.data;
    },
  });
}

export function useSeason(seasonId: string) {
  return useQuery({
    queryKey: seasonKeys.detail(seasonId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; season: Season }>(
        `/seasons/${seasonId}`
      );
      return response.data.season;
    },
    enabled: !!seasonId,
  });
}

export function useCreateSeason() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateSeasonInput) => {
      const response = await apiClient.post<{ success: boolean; season: Season }>(
        '/seasons',
        data
      );
      return response.data.season;
    },
    onSuccess: (season) => {
      // Invalidate season lists
      queryClient.invalidateQueries({ queryKey: seasonKeys.lists() });
      // Also invalidate the league detail since it includes seasons
      queryClient.invalidateQueries({ queryKey: ['leagues', 'detail', season.leagueId] });
    },
  });
}

export function useUpdateSeason() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ seasonId, data }: { seasonId: string; data: UpdateSeasonInput }) => {
      const response = await apiClient.patch<{ success: boolean; season: Season }>(
        `/seasons/${seasonId}`,
        data
      );
      return response.data.season;
    },
    onSuccess: (season, variables) => {
      queryClient.invalidateQueries({ queryKey: seasonKeys.lists() });
      queryClient.invalidateQueries({ queryKey: seasonKeys.detail(variables.seasonId) });
    },
  });
}

export function useDeleteSeason() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (seasonId: string) => {
      await apiClient.delete(`/seasons/${seasonId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: seasonKeys.lists() });
    },
  });
}
