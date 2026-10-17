import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import type { GuardianRelationship } from '../../shared/types';

export type InvitationByTokenStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface TeamInvitationByToken {
  /** Older API builds omit `kind`; treat `undefined` as a team invitation. */
  kind?: 'team';
  id: string;
  status: InvitationByTokenStatus;
  teamName: string;
  inviterName: string;
  /**
   * Set when the inviter's account was deleted (#642); render the inviter via
   * `displayName`. Older API builds omit it.
   */
  inviterDeletedAt?: string | null;
  position: string | null;
  jerseyNumber: number | null;
  message: string | null;
  expiresAt: string;
}

/** Guardian (PARENT role) invitation — docs/plans/parent-role-spec.md. */
export interface GuardianInvitationByToken {
  kind: 'guardian';
  id: string;
  status: InvitationByTokenStatus;
  childName: string;
  teamName: string | null;
  inviterName: string;
  relationship: GuardianRelationship;
  expiresAt: string;
}

export type InvitationByToken = TeamInvitationByToken | GuardianInvitationByToken;

export function isGuardianInvitation(
  invitation: InvitationByToken | null | undefined
): invitation is GuardianInvitationByToken {
  return invitation?.kind === 'guardian';
}

interface ApiResponse {
  success: boolean;
  invitation: InvitationByToken;
}

export function useInvitationByToken(token: string | undefined) {
  return useQuery({
    queryKey: ['invitationByToken', token],
    queryFn: async () => {
      const response = await apiClient.get<ApiResponse>(
        `/invitations/by-token/${token}`
      );
      return response.data.invitation;
    },
    enabled: !!token,
    retry: false,
  });
}
