/**
 * React Query hooks for team staff management
 * (`/teams/:teamId/staff`, `/teams/:teamId/roles` — role matrix B2.3).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { teamKeys, type TeamStaff } from './useTeams';
import { usageKeys } from './useUsage';

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

export const teamStaffKeys = {
  all: ['team-staff'] as const,
  list: (teamId: string) => [...teamStaffKeys.all, 'list', teamId] as const,
  roles: (teamId: string) => [...teamStaffKeys.all, 'roles', teamId] as const,
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
    queryClient.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
    queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    // Staff membership is what the FREE-tier team cap counts (#43 / B2.8).
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
    onSuccess: (_, variables) => invalidate(variables.teamId),
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
    onSuccess: (_, variables) => invalidate(variables.teamId),
  });
}

export function useRemoveStaff() {
  const invalidate = useInvalidateStaff();

  return useMutation({
    mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
      await apiClient.delete(`/teams/${teamId}/staff/${userId}`);
    },
    onSuccess: (_, variables) => invalidate(variables.teamId),
  });
}
