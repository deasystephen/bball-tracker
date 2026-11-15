/**
 * React Query hooks for team staff management
 * (`/teams/:teamId/staff`, `/teams/:teamId/roles` — role matrix B2.3).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';
import type { TeamStaff } from './useTeams';
import { usageKeys } from './useUsage';
import { gameKeys, teamKeys } from './query-keys';
import { useAuthStore } from '../store/auth-store';

export type StaffRoleType = 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER';

export const STAFF_ROLE_TYPES: readonly StaffRoleType[] = [
  'HEAD_COACH',
  'ASSISTANT_COACH',
  'TEAM_MANAGER',
] as const;

export interface TeamStaffRow extends TeamStaff {
  teamId: string;
  roleId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRole {
  id: string;
  teamId: string;
  type: StaffRoleType | 'CUSTOM';
  name: string;
  description?: string | null;
  canManageTeam: boolean;
  canManageRoster: boolean;
  canTrackStats: boolean;
  canViewStats: boolean;
  canShareStats: boolean;
}

export type AddStaffInput =
  | { userId: string; roleType: StaffRoleType }
  | { email: string; roleType: StaffRoleType };

/**
 * A pending staff invitation on the team (#460), as `GET
 * /teams/:teamId/staff-invitations` lists it to callers who may manage staff.
 * The address may have no account yet; none exists until the invitee accepts.
 * Never carries the token.
 */
export interface StaffInvitationRow {
  id: string;
  teamId: string;
  invitedEmail: string;
  roleType: StaffRoleType;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; name: string; deletedAt: string | null };
}

export interface InviteStaffInput {
  email: string;
  roleType: StaffRoleType;
  /** Resend: expire the live invitation and send a fresh link (the old one dies). */
  supersede?: boolean;
}

/** What `POST /teams/:teamId/staff-invitations` returns (no `invitedBy` object). */
export type StaffInvitationSummary = Omit<StaffInvitationRow, 'invitedBy'> & { invitedById: string };

export interface InviteStaffResult {
  invitation: StaffInvitationSummary;
  /** `false`: the invitation exists but the email failed; warn the coach. */
  emailSent: boolean;
}

export const teamStaffKeys = {
  all: ['team-staff'] as const,
  list: (teamId: string) => [...teamStaffKeys.all, 'list', teamId] as const,
  roles: (teamId: string) => [...teamStaffKeys.all, 'roles', teamId] as const,
  invitations: (teamId: string) => [...teamStaffKeys.all, 'invitations', teamId] as const,
};

export function useTeamStaff(teamId: string) {
  return useQuery({
    queryKey: teamStaffKeys.list(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; staff: TeamStaffRow[] }>(
        `/teams/${teamId}/staff`
      );
      return response.data.staff ?? [];
    },
    enabled: !!teamId,
  });
}

export function useTeamRoles(teamId: string) {
  return useQuery({
    queryKey: teamStaffKeys.roles(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; roles: TeamRole[] }>(
        `/teams/${teamId}/roles`
      );
      return response.data.roles ?? [];
    },
    enabled: !!teamId,
  });
}

function useInvalidateStaff() {
  const queryClient = useQueryClient();
  return (teamId: string) => {
    queryClient.invalidateQueries({ queryKey: teamStaffKeys.list(teamId) });
    // Removing or demoting a head coach cancels their pending staff invitations (#460).
    queryClient.invalidateQueries({ queryKey: teamStaffKeys.invitations(teamId) });
    queryClient.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
    queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    // Staff membership is what the usage meter counts (#43 / B2.8).
    queryClient.invalidateQueries({ queryKey: usageKeys.all });
  };
}

export function useAddStaff() {
  const invalidate = useInvalidateStaff();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: AddStaffInput }) => {
      const response = await apiClient.post<{ success: boolean; staff: TeamStaffRow }>(
        `/teams/${teamId}/staff`,
        data
      );
      return response.data.staff;
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.STAFF_ADDED, {
        team_id: variables.teamId,
        role_type: variables.data.roleType,
        by: 'userId' in variables.data ? 'user_id' : 'email',
      });
      invalidate(variables.teamId);
    },
  });
}

/**
 * Pending staff invitations of a team. Only callers who may manage staff can
 * read them (the API answers 403 otherwise), so pass `enabled` from the same
 * `canManageStaff` that renders the controls.
 */
export function useStaffInvitations(teamId: string, enabled: boolean) {
  return useQuery({
    queryKey: teamStaffKeys.invitations(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; invitations: StaffInvitationRow[] }>(
        `/teams/${teamId}/staff-invitations`
      );
      return response.data.invitations ?? [];
    },
    enabled: !!teamId && enabled,
  });
}

/** Invite an address (with or without an account) to a staff role (#460). */
export function useInviteStaff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: InviteStaffInput }): Promise<InviteStaffResult> => {
      const response = await apiClient.post<{ success: boolean } & InviteStaffResult>(
        `/teams/${teamId}/staff-invitations`,
        data
      );
      return { invitation: response.data.invitation, emailSent: response.data.emailSent };
    },
    onSuccess: (result, variables) => {
      trackEvent(AnalyticsEvents.STAFF_INVITED, {
        team_id: variables.teamId,
        invitation_id: result.invitation.id,
        role_type: variables.data.roleType,
        resend: !!variables.data.supersede,
        email_sent: result.emailSent,
      });
      queryClient.invalidateQueries({ queryKey: teamStaffKeys.invitations(variables.teamId) });
    },
  });
}

/** Cancel a pending staff invitation; its link stops working. */
export function useCancelStaffInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, invitationId }: { teamId: string; invitationId: string }) => {
      await apiClient.delete(`/teams/${teamId}/staff-invitations/${invitationId}`);
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.STAFF_INVITATION_CANCELLED, {
        team_id: variables.teamId,
        invitation_id: variables.invitationId,
      });
      queryClient.invalidateQueries({ queryKey: teamStaffKeys.invitations(variables.teamId) });
    },
  });
}

export function useUpdateStaffRole() {
  const invalidate = useInvalidateStaff();

  return useMutation({
    mutationFn: async ({
      teamId,
      userId,
      roleType,
    }: {
      teamId: string;
      userId: string;
      roleType: StaffRoleType;
    }) => {
      const response = await apiClient.patch<{ success: boolean; staff: TeamStaffRow }>(
        `/teams/${teamId}/staff/${userId}`,
        { roleType }
      );
      return response.data.staff;
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.STAFF_ROLE_UPDATED, {
        team_id: variables.teamId,
        role_type: variables.roleType,
      });
      invalidate(variables.teamId);
    },
  });
}

export function useRemoveStaff() {
  const invalidate = useInvalidateStaff();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
      await apiClient.delete(`/teams/${teamId}/staff/${userId}`);
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.STAFF_REMOVED, { team_id: variables.teamId });
      invalidate(variables.teamId);
      // Leaving a team's staff ("Leave team") changes which games the caller
      // may list (GET /games is membership-scoped, #729). Removing someone
      // else does not, so only self-removal refetches the games lists.
      if (variables.userId === useAuthStore.getState().user?.id) {
        queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
      }
    },
  });
}
