import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { AxiosError } from 'axios';

export interface InvitationByToken {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  teamName: string;
  inviterName: string;
  position: string | null;
  jerseyNumber: number | null;
  message: string | null;
  expiresAt: string;
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

export function useAcceptInvitationByToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const response = await apiClient.post<{ success: boolean; message: string }>(
        `/invitations/by-token/${token}/accept`
      );
      return response.data;
    },
    onSuccess: (_data, token) => {
      queryClient.invalidateQueries({ queryKey: ['invitationByToken', token] });
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
    onError: (error: AxiosError<{ error: string }>) => {
      return error.response?.data?.error ?? 'Failed to accept invitation';
    },
  });
}
