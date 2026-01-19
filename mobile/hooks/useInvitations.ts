/**
 * React Query hooks for invitations API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface TeamInvitation {
  id: string;
  teamId: string;
  playerId: string;
  invitedById: string;
  status: InvitationStatus;
  token: string;
  jerseyNumber?: number | null;
  position?: string | null;
  message?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string | null;
  rejectedAt?: string | null;
  team: {
    id: string;
    name: string;
    league: {
      id: string;
      name: string;
      season: string;
      year: number;
    };
  };
  player: {
    id: string;
    name: string;
    email: string;
  };
  invitedBy: {
    id: string;
    name: string;
    email: string;
  };
}

export interface InvitationsResponse {
  success: boolean;
  invitations: TeamInvitation[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface InvitationResponse {
  success: boolean;
  invitation: TeamInvitation;
  teamMember?: {
    id: string;
    teamId: string;
    playerId: string;
    jerseyNumber?: number | null;
    position?: string | null;
  };
  message?: string;
}

export interface CreateInvitationInput {
  playerId: string;
  jerseyNumber?: number;
  position?: string;
  message?: string;
  expiresInDays?: number;
}

export interface InvitationsQueryParams {
  status?: InvitationStatus;
  teamId?: string;
  playerId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Query key factory for invitations
 */
export const invitationKeys = {
  all: ['invitations'] as const,
  lists: () => [...invitationKeys.all, 'list'] as const,
  list: (params?: InvitationsQueryParams) => [...invitationKeys.lists(), params] as const,
  details: () => [...invitationKeys.all, 'detail'] as const,
  detail: (id: string) => [...invitationKeys.details(), id] as const,
  team: (teamId: string) => [...invitationKeys.all, 'team', teamId] as const,
  player: (playerId: string) => [...invitationKeys.all, 'player', playerId] as const,
};

/**
 * Hook to fetch list of invitations
 */
export function useInvitations(params?: InvitationsQueryParams) {
  return useQuery<InvitationsResponse>({
    queryKey: invitationKeys.list(params),
    queryFn: async () => {
      const response = await apiClient.get<InvitationsResponse>('/invitations', {
        params,
      });
      return response.data;
    },
  });
}

/**
 * Hook to fetch a single invitation by ID
 */
export function useInvitation(invitationId: string) {
  return useQuery<InvitationResponse>({
    queryKey: invitationKeys.detail(invitationId),
    queryFn: async () => {
      const response = await apiClient.get<InvitationResponse>(`/invitations/${invitationId}`);
      return response.data;
    },
    enabled: !!invitationId,
  });
}

/**
 * Hook to fetch invitations for a specific team
 */
export function useTeamInvitations(teamId: string, status?: InvitationStatus) {
  return useInvitations({ teamId, status });
}

/**
 * Hook to fetch invitations for the current player
 */
export function usePlayerInvitations(status?: InvitationStatus) {
  return useInvitations({ status });
}

/**
 * Hook to create a new invitation
 */
export function useCreateInvitation() {
  const queryClient = useQueryClient();

  return useMutation<
    InvitationResponse,
    Error,
    { teamId: string; data: CreateInvitationInput }
  >({
    mutationFn: async ({ teamId, data }) => {
      const response = await apiClient.post<InvitationResponse>(
        `/teams/${teamId}/invitations`,
        data
      );
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate invitation lists
      queryClient.invalidateQueries({ queryKey: invitationKeys.lists() });
      queryClient.invalidateQueries({ queryKey: invitationKeys.team(variables.teamId) });
    },
  });
}

/**
 * Hook to accept an invitation
 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient();

  return useMutation<InvitationResponse, Error, string>({
    mutationFn: async (invitationId) => {
      const response = await apiClient.post<InvitationResponse>(
        `/invitations/${invitationId}/accept`
      );
      return response.data;
    },
    onSuccess: (data) => {
      // Invalidate all invitation queries
      queryClient.invalidateQueries({ queryKey: invitationKeys.all });
      // Invalidate team members if teamMember was returned
      if (data.teamMember) {
        queryClient.invalidateQueries({ queryKey: ['teams'] });
      }
    },
  });
}

/**
 * Hook to reject an invitation
 */
export function useRejectInvitation() {
  const queryClient = useQueryClient();

  return useMutation<InvitationResponse, Error, string>({
    mutationFn: async (invitationId) => {
      const response = await apiClient.post<InvitationResponse>(
        `/invitations/${invitationId}/reject`
      );
      return response.data;
    },
    onSuccess: () => {
      // Invalidate all invitation queries
      queryClient.invalidateQueries({ queryKey: invitationKeys.all });
    },
  });
}

/**
 * Hook to cancel an invitation (coach only)
 */
export function useCancelInvitation() {
  const queryClient = useQueryClient();

  return useMutation<InvitationResponse, Error, string>({
    mutationFn: async (invitationId) => {
      const response = await apiClient.delete<InvitationResponse>(
        `/invitations/${invitationId}`
      );
      return response.data;
    },
    onSuccess: () => {
      // Invalidate all invitation queries
      queryClient.invalidateQueries({ queryKey: invitationKeys.all });
    },
  });
}
