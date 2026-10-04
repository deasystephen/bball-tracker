/**
 * React Query hooks for invitations API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';
import { teamKeys, invitationKeys, type InvitationsQueryParams } from './query-keys';
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
    email?: string | null;
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
  /**
   * Whether the invitation email was delivered to the mailer. `false` = the
   * send failed (warn the coach — the invite still exists in-app); `null` =
   * the player has no email address. Older API builds omit it.
   */
  emailSent?: boolean | null;
}

/**
 * Invite an existing user by `playerId`. New players are created through the
 * unified Add Player call (`useAddRosterPlayer`); the server no longer accepts
 * `name` + `email` here (#418).
 */
export type CreateInvitationInput = {
  playerId: string;
  jerseyNumber?: number;
  position?: string;
  message?: string;
  expiresInDays?: number;
  /**
   * Resend: expire the player's live PENDING invitation and create a fresh one
   * (new token, old link dies) in one server-side transaction. "Resend" and
   * "Invite" on the roster are both this call with `supersede: true`.
   */
  supersede?: boolean;
};

// Query key factories live in ./query-keys (dependency-free, cycle-safe).
export { invitationKeys };
export type { InvitationsQueryParams };

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
      trackEvent(AnalyticsEvents.INVITATION_SENT, {
        team_id: variables.teamId,
        invitation_id: data.invitation?.id ?? '',
        resend: !!variables.data.supersede,
        email_sent: data.emailSent ?? null,
      });
      // lists() covers every invitation query, incl. useTeamInvitations
      queryClient.invalidateQueries({ queryKey: invitationKeys.lists() });
      // The team payload's invite-status join changed (chips)
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
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
      trackEvent(AnalyticsEvents.INVITATION_ACCEPTED, {
        kind: data.kind === 'guardian' ? 'guardian' : 'team',
        source: 'in_app',
      });
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
    onSuccess: (_data, invitationId) => {
      trackEvent(AnalyticsEvents.INVITATION_DECLINED, { invitation_id: invitationId });
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

  return useMutation<InvitationResponse, Error, { invitationId: string; teamId: string }>({
    mutationFn: async ({ invitationId }) => {
      const response = await apiClient.delete<InvitationResponse>(
        `/invitations/${invitationId}`
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      trackEvent(AnalyticsEvents.INVITATION_CANCELLED, {
        team_id: variables.teamId,
        invitation_id: variables.invitationId,
      });
      // lists() covers every invitation query, incl. useTeamInvitations
      queryClient.invalidateQueries({ queryKey: invitationKeys.lists() });
      // Chip flips to "Not invited" — invalidate only THIS team's detail
      // (an unscoped teams-details key would refetch every cached team)
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
    },
  });
}
