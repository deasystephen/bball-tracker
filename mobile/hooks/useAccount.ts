/**
 * Account deletion (#444, App Store 5.1.1(v)).
 *
 * - `useDeleteAccount` → `DELETE /auth/me`. The server anonymizes the account
 *   in place and deletes the WorkOS user; on success the hook clears the LOCAL
 *   session only (`clearSession`, no remote logout — the server side is
 *   already gone). Never the other way round: clearing local state is not a
 *   deletion.
 * - `useDeleteChildRecord` → `DELETE /players/:id/account` for a managed,
 *   unclaimed child the caller is a guardian of; then re-reads `GET /auth/me`
 *   so "My kids" drops the child at once (same pattern as a guardian accept).
 *
 * A 400 `code: 'last_head_coach'` carries `teams: [{ id, name }]`; read it
 * with `getLastHeadCoachTeams(error)`.
 */
import { useMutation } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { apiClient, type NormalizedApiError } from '../services/api-client';
import { useAuthStore } from '../store/auth-store';
import type { User } from '../../shared/types';

export const LAST_HEAD_COACH_CODE = 'last_head_coach';

export interface DeleteAccountResponse {
  success: boolean;
  identityDeleted: boolean;
}

export interface BlockingTeam {
  id: string;
  name: string;
}

/** The teams named by a `last_head_coach` refusal, or null for any other error. */
export function getLastHeadCoachTeams(error: unknown): BlockingTeam[] | null {
  if (!isAxiosError(error)) return null;
  const info = (error as NormalizedApiError).apiError;
  if (info?.code !== LAST_HEAD_COACH_CODE || !Array.isArray(info.teams)) return null;
  return (info.teams as unknown[]).flatMap((team) =>
    team && typeof team === 'object' && typeof (team as BlockingTeam).id === 'string'
      ? [{ id: (team as BlockingTeam).id, name: String((team as BlockingTeam).name ?? '') }]
      : []
  );
}

export function useDeleteAccount() {
  return useMutation<DeleteAccountResponse, Error, void>({
    mutationFn: async () => {
      const response = await apiClient.delete<DeleteAccountResponse>('/auth/me');
      return response.data;
    },
    onSuccess: () => {
      // Local only: the account no longer exists server-side, and the old
      // token would 401 anyway. clearSession also resets the socket + cache.
      useAuthStore.getState().clearSession();
    },
  });
}

interface MeResponse {
  success: boolean;
  user: Partial<User>;
}

export function useDeleteChildRecord() {
  return useMutation<void, Error, { childId: string }>({
    mutationFn: async ({ childId }) => {
      await apiClient.delete(`/players/${childId}/account`);
    },
    onSuccess: async () => {
      // The child is gone from every guardian's list; refresh guardianOf now
      // rather than waiting for useSessionRefresh's next foreground sync.
      try {
        const me = await apiClient.get<MeResponse>('/auth/me');
        if (me.data?.user) {
          useAuthStore.getState().updateUser({ guardianOf: me.data.user.guardianOf ?? [], role: me.data.user.role });
        }
      } catch {
        // Best-effort; the session refresh hook catches up later.
      }
    },
  });
}
