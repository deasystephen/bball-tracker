/**
 * Self-service profile edits for the signed-in user (PATCH /auth/me).
 *
 * Works for every role. The Profile tab previously went through
 * PATCH /players/:id, which only accepts PLAYER rows and therefore 404ed for
 * every ADMIN/COACH avatar change (audit #10).
 */

import { useMutation } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { useAuthStore } from '../store/auth-store';
import type { User } from '../../shared/types';

export interface UpdateProfileInput {
  name?: string;
  /** Empty string clears the avatar. */
  profilePictureUrl?: string;
}

export interface ProfileResponse {
  success: boolean;
  user: {
    id: string;
    email: string | null;
    name: string;
    role: User['role'];
    profilePictureUrl: string | null;
    createdAt: string;
  };
}

/** Map the API's nullable avatar onto the store's optional field. */
export function toUserPatch(user: ProfileResponse['user']): Partial<User> {
  return {
    name: user.name,
    profilePictureUrl: user.profilePictureUrl ?? undefined,
  };
}

export function useUpdateProfile() {
  return useMutation<ProfileResponse, Error, UpdateProfileInput>({
    mutationFn: async (data) => {
      const response = await apiClient.patch<ProfileResponse>('/auth/me', data);
      return response.data;
    },
    onSuccess: (data) => {
      // Merge without re-firing login analytics (setUser would).
      useAuthStore.getState().updateUser(toUserPatch(data.user));
    },
  });
}
