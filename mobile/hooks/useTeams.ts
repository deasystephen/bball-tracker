/**
 * React Query hooks for Teams API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

// Types
export interface TeamStaff {
  id: string;
  userId: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
  role: {
    id: string;
    name: string;
    type: 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER' | 'CUSTOM';
    canManageTeam: boolean;
    canManageRoster: boolean;
    canTrackStats: boolean;
    canViewStats: boolean;
    canShareStats: boolean;
  };
}

export interface TeamMember {
  id: string;
  playerId: string;
  jerseyNumber?: number | null;
  position?: string | null;
  player: {
    id: string;
    name: string;
    email?: string | null;
    isManaged?: boolean;
  };
}

export interface Team {
  id: string;
  name: string;
  seasonId: string;
  createdAt: string;
  updatedAt: string;
  season?: {
    id: string;
    name: string;
    isActive: boolean;
    league: {
      id: string;
      name: string;
    };
  };
  staff?: TeamStaff[];
  members?: TeamMember[];
  _count?: {
    members: number;
    staff: number;
    games: number;
  };
  roles?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  games?: Array<{
    id: string;
    opponent: string;
    date: string;
    status: string;
  }>;
}

export interface CreateTeamInput {
  name: string;
  seasonId: string;
}

export interface UpdateTeamInput {
  name?: string;
  seasonId?: string;
}

export interface AddPlayerInput {
  playerId: string;
  jerseyNumber?: number;
  position?: string;
}

export interface TeamFilters {
  seasonId?: string;
  leagueId?: string;
  playerId?: string;
  limit?: number;
  offset?: number;
}

export interface TeamsResponse {
  success: boolean;
  teams: Team[];
  total: number;
  limit: number;
  offset: number;
}

// Query keys
export const teamKeys = {
  all: ['teams'] as const,
  lists: () => [...teamKeys.all, 'list'] as const,
  list: (filters?: TeamFilters) => [...teamKeys.lists(), filters] as const,
  details: () => [...teamKeys.all, 'detail'] as const,
  detail: (id: string) => [...teamKeys.details(), id] as const,
};

// Hooks
export function useTeams(filters?: TeamFilters) {
  return useQuery({
    queryKey: teamKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.seasonId) params.append('seasonId', filters.seasonId);
      if (filters?.leagueId) params.append('leagueId', filters.leagueId);
      if (filters?.playerId) params.append('playerId', filters.playerId);
      if (filters?.limit) params.append('limit', String(filters.limit));
      if (filters?.offset) params.append('offset', String(filters.offset));

      const response = await apiClient.get<TeamsResponse>(`/teams?${params.toString()}`);
      return response.data.teams;
    },
  });
}

export function useTeam(teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; team: Team }>(
        `/teams/${teamId}`
      );
      return response.data.team;
    },
    enabled: !!teamId,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateTeamInput) => {
      const response = await apiClient.post<{ success: boolean; team: Team }>('/teams', data);
      return response.data.team;
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
      const response = await apiClient.patch<{ success: boolean; team: Team }>(
        `/teams/${teamId}`,
        data
      );
      return response.data.team;
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

// Helper to check if user is a staff member with specific permission
export function hasTeamPermission(
  team: Team | undefined,
  userId: string | undefined,
  permission: 'canManageTeam' | 'canManageRoster' | 'canTrackStats' | 'canViewStats' | 'canShareStats'
): boolean {
  if (!team || !userId) return false;

  const staffMember = team.staff?.find((s) => s.userId === userId);
  if (!staffMember) return false;

  return staffMember.role[permission];
}

// Helper to check if user is a head coach
export function isHeadCoach(team: Team | undefined, userId: string | undefined): boolean {
  if (!team || !userId) return false;

  return team.staff?.some(
    (s) => s.userId === userId && s.role.type === 'HEAD_COACH'
  ) ?? false;
}

// Helper to get user's role on a team
export function getUserTeamRole(team: Team | undefined, userId: string | undefined): TeamStaff['role'] | null {
  if (!team || !userId) return null;

  const staffMember = team.staff?.find((s) => s.userId === userId);
  return staffMember?.role ?? null;
}
