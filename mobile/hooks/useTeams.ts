/**
 * React Query hooks for Teams API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

// Types
export interface Team {
  id: string;
  name: string;
  leagueId: string;
  coachId: string;
  createdAt: string;
  updatedAt: string;
  league?: {
    id: string;
    name: string;
    season: string;
    year: number;
  };
  coach?: {
    id: string;
    name: string;
    email: string;
  };
  members?: Array<{
    id: string;
    playerId: string;
    jerseyNumber?: number;
    position?: string;
    player: {
      id: string;
      name: string;
      email: string;
    };
  }>;
}

export interface CreateTeamInput {
  name: string;
  leagueId: string;
  coachId?: string;
}

export interface UpdateTeamInput {
  name?: string;
  leagueId?: string;
}

export interface AddPlayerInput {
  playerId: string;
  jerseyNumber?: number;
  position?: string;
}

// Query keys
export const teamKeys = {
  all: ['teams'] as const,
  lists: () => [...teamKeys.all, 'list'] as const,
  list: (filters?: { leagueId?: string; coachId?: string }) =>
    [...teamKeys.lists(), filters] as const,
  details: () => [...teamKeys.all, 'detail'] as const,
  detail: (id: string) => [...teamKeys.details(), id] as const,
};

// Hooks
export function useTeams(filters?: { leagueId?: string; coachId?: string }) {
  return useQuery({
    queryKey: teamKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.leagueId) params.append('leagueId', filters.leagueId);
      if (filters?.coachId) params.append('coachId', filters.coachId);

      const response = await apiClient.get(`/teams?${params.toString()}`);
      return response.data.teams as Team[];
    },
  });
}

export function useTeam(teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(teamId),
    queryFn: async () => {
      const response = await apiClient.get(`/teams/${teamId}`);
      return response.data.team as Team;
    },
    enabled: !!teamId,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateTeamInput) => {
      const response = await apiClient.post('/teams', data);
      return response.data.team as Team;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: UpdateTeamInput }) => {
      const response = await apiClient.patch(`/teams/${teamId}`, data);
      return response.data.team as Team;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (teamId: string) => {
      await apiClient.delete(`/teams/${teamId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

export function useAddPlayerToTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: AddPlayerInput }) => {
      const response = await apiClient.post(`/teams/${teamId}/players`, data);
      return response.data.teamMember;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
    },
  });
}

export function useRemovePlayerFromTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, playerId }: { teamId: string; playerId: string }) => {
      await apiClient.delete(`/teams/${teamId}/players/${playerId}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
    },
  });
}
