/**
 * React Query hooks for a roster player's guardians
 * (`/teams/:teamId/members/:playerId/guardians` — PARENT role,
 * docs/plans/parent-role-spec.md).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { teamKeys } from './useTeams';
import { invitationKeys } from './useInvitations';
import type { GuardianRelationship } from '../../shared/types';

export interface GuardianRow {
  id: string;
  userId: string;
  name: string;
  /** Only present when the caller has `canManageRoster` on the team. */
  email?: string | null;
  relationship: GuardianRelationship;
  isPrimary: boolean;
  createdAt: string;
}

export interface PendingGuardianInvitation {
  id: string;
  childId: string;
  teamId: string | null;
  invitedEmail: string;
  relationship: GuardianRelationship;
  invitedById: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string | null;
}

export interface GuardianList {
  guardians: GuardianRow[];
  pendingInvitations: PendingGuardianInvitation[];
}

export interface InviteGuardianInput {
  email: string;
  relationship: GuardianRelationship;
}

export const guardianKeys = {
  all: ['guardians'] as const,
  player: (teamId: string, playerId: string) => [...guardianKeys.all, teamId, playerId] as const,
};

export function usePlayerGuardians(teamId: string, playerId: string) {
  return useQuery({
    queryKey: guardianKeys.player(teamId, playerId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean } & GuardianList>(
        `/teams/${teamId}/members/${playerId}/guardians`
      );
      return {
        guardians: response.data.guardians ?? [],
        pendingInvitations: response.data.pendingInvitations ?? [],
      };
    },
    enabled: !!teamId && !!playerId,
  });
}

function useInvalidateGuardians() {
  const queryClient = useQueryClient();
  return (teamId: string, playerId: string) => {
    queryClient.invalidateQueries({ queryKey: guardianKeys.player(teamId, playerId) });
    queryClient.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
  };
}

export function useInviteGuardian() {
  const invalidate = useInvalidateGuardians();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      teamId,
      playerId,
      data,
    }: {
      teamId: string;
      playerId: string;
      data: InviteGuardianInput;
    }) => {
      const response = await apiClient.post<{
        success: boolean;
        invitation: PendingGuardianInvitation;
      }>(`/teams/${teamId}/members/${playerId}/guardians`, data);
      return response.data.invitation;
    },
    onSuccess: (_, variables) => {
      invalidate(variables.teamId, variables.playerId);
      queryClient.invalidateQueries({ queryKey: invitationKeys.all });
    },
  });
}

export function useRemoveGuardian() {
  const invalidate = useInvalidateGuardians();

  return useMutation({
    mutationFn: async ({
      teamId,
      playerId,
      guardianUserId,
    }: {
      teamId: string;
      playerId: string;
      guardianUserId: string;
    }) => {
      await apiClient.delete(`/teams/${teamId}/members/${playerId}/guardians/${guardianUserId}`);
    },
    onSuccess: (_, variables) => invalidate(variables.teamId, variables.playerId),
  });
}
