/**
 * React Query hooks for Leagues API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { Season } from './useSeasons';

// Types
export interface LeagueAdmin {
  id: string;
  userId: string;
  user: {
    id: string;
    name: string;
    email?: string;
  };
}

export interface League {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  seasons?: Array<{
    id: string;
    name: string;
    isActive: boolean;
  }>;
  admins?: LeagueAdmin[];
  _count?: {
    seasons: number;
  };
}

export interface LeagueDetail extends League {
  seasons?: Season[];
}

export interface CreateLeagueInput {
  name: string;
}

export interface UpdateLeagueInput {
  name?: string;
}

export interface LeagueFilters {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LeaguesResponse {
  success: boolean;
  leagues: League[];
  total: number;
  limit: number;
  offset: number;
}

// Query keys
export const leagueKeys = {
  all: ['leagues'] as const,
  lists: () => [...leagueKeys.all, 'list'] as const,
  list: (filters?: LeagueFilters) => [...leagueKeys.lists(), filters] as const,
  details: () => [...leagueKeys.all, 'detail'] as const,
  detail: (id: string) => [...leagueKeys.details(), id] as const,
};

// Hooks
export function useLeagues(filters?: LeagueFilters) {
  return useQuery({
    queryKey: leagueKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.search) params.append('search', filters.search);
      if (filters?.limit) params.append('limit', String(filters.limit));
      if (filters?.offset) params.append('offset', String(filters.offset));

      const response = await apiClient.get<LeaguesResponse>(`/leagues?${params.toString()}`);
      return response.data.leagues;
    },
  });
}

export function useLeague(leagueId: string) {
  return useQuery({
    queryKey: leagueKeys.detail(leagueId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; league: LeagueDetail }>(
        `/leagues/${leagueId}`
      );
      return response.data.league;
    },
    enabled: !!leagueId,
  });
}

export function useCreateLeague() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateLeagueInput) => {
      const response = await apiClient.post<{ success: boolean; league: League }>(
        '/leagues',
        data
      );
      return response.data.league;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leagueKeys.lists() });
    },
  });
}

export function useUpdateLeague() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ leagueId, data }: { leagueId: string; data: UpdateLeagueInput }) => {
      const response = await apiClient.patch<{ success: boolean; league: League }>(
        `/leagues/${leagueId}`,
        data
      );
      return response.data.league;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: leagueKeys.lists() });
      queryClient.invalidateQueries({ queryKey: leagueKeys.detail(variables.leagueId) });
    },
  });
}

export function useDeleteLeague() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (leagueId: string) => {
      await apiClient.delete(`/leagues/${leagueId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leagueKeys.lists() });
    },
  });
}
