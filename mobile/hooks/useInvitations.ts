/**
 * React Query hooks for invitations API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import type { GuardianRelationship } from '../../shared/types';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface TeamInvitation {
  id: string;
  teamId: string;
  playerId: string;
  invitedById: string;
  status: InvitationStatus;
  // The secret `token` is never returned on authenticated responses — it only
  // travels inside the invitation email (backend audit #14).
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
    season: {
      id: string;
      name: string;
      isActive: boolean;
      league: {
        id: string;
        name: string;
      };
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

export type InvitationKind = 'team' | 'guardian';

/**
 * A pending guardian invitation addressed to the signed-in adult (PARENT
 * role). Surfaced on the unfiltered / PENDING `GET /invitations` as
 * `guardianInvitations`; accepted through `POST /invitations/:id/accept`.
 */
export interface GuardianInvitationView {
  kind: 'guardian';
  id: string;
  status: InvitationStatus;
  childName: string;
  teamName: string | null;
  inviterName: string;
  relationship: GuardianRelationship;
  expiresAt: string;
}

export interface InvitationsResponse {
  success: boolean;
  invitations: TeamInvitation[];
  /** Optional: older API builds omit it. */
  guardianInvitations?: GuardianInvitationView[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface InvitationResponse {
  success: boolean;
  /** Which invitation model the id resolved to; older API builds omit it. */
  kind?: InvitationKind;
  invitation: TeamInvitation;
  /** Present on `kind: 'guardian'` accepts — the new Guardian link. */
  guardian?: {
    id: string;
    parentId: string;
    childId: string;
    relationship: GuardianRelationship;
    isPrimary: boolean;
  };
  teamMember?: {
    id: string;
    teamId: string;
    playerId: string;
    jerseyNumber?: number | null;
    position?: string | null;
  };
  message?: string;
}

/**
 * Invite an existing user by `playerId`, or create-and-invite a new player in
 * a single backend call with `name` + `email` (the server creates the user
 * and the invitation in one transaction, so a failure leaves no orphan
 * player — audit #69).
 */
export type CreateInvitationInput = {
  jerseyNumber?: number;
  position?: string;
  message?: string;
  expiresInDays?: number;
} & (
  | { playerId: string; name?: never; email?: never; profilePictureUrl?: never }
  | { playerId?: never; name: string; email: string; profilePictureUrl?: string }
);

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
      if (variables.data.email) {
        // A new player account may have been created; refresh player search
        queryClient.invalidateQueries({ queryKey: ['players'] });
      }
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
      // A guardian accept unlocks the child's teams / games (PARENT role).
      if (data.kind === 'guardian') {
        queryClient.invalidateQueries({ queryKey: ['teams'] });
        queryClient.invalidateQueries({ queryKey: ['games'] });
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
