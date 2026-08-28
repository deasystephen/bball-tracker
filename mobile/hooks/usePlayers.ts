/**
 * React Query hooks for players API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { playerKeys, type PlayersQueryParams } from './query-keys';

export interface Player {
  id: string;
  email?: string | null;
  name: string;
  role: 'PLAYER' | 'COACH' | 'PARENT' | 'ADMIN';
  profilePictureUrl?: string | null;
  emailVerified: boolean;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
  teamMembers?: {
    id: string;
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
  }[];
  _count?: {
    teamMembers: number;
  };
}

export interface PlayersResponse {
  success: boolean;
  players: Player[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface PlayerResponse {
  success: boolean;
  player: Player;
}

export interface CreatePlayerInput {
  email: string;
  name: string;
  profilePictureUrl?: string;
}

export interface UpdatePlayerInput {
  name?: string;
  email?: string;
  profilePictureUrl?: string;
}

// Query key factory lives in ./query-keys (dependency-free, cycle-safe) so
// cross-invalidating hooks never hardcode a ['players'] literal.
export { playerKeys };
export type { PlayersQueryParams };

/**
 * Hook to fetch list of players
 */
export function usePlayers(params?: PlayersQueryParams) {
  return useQuery<PlayersResponse>({
    queryKey: playerKeys.list(params),
    queryFn: async () => {
      const response = await apiClient.get<PlayersResponse>('/players', {
        params,
      });
      return response.data;
    },
  });
}

/**
 * Hook to fetch a single player by ID
 */
export function usePlayer(playerId: string) {
  return useQuery<PlayerResponse>({
    queryKey: playerKeys.detail(playerId),
    queryFn: async () => {
      const response = await apiClient.get<PlayerResponse>(`/players/${playerId}`);
      return response.data;
    },
    enabled: !!playerId,
  });
}

/**
 * Hook to create a new player
 */
export function useCreatePlayer() {
  const queryClient = useQueryClient();

  return useMutation<PlayerResponse, Error, CreatePlayerInput>({
    mutationFn: async (data) => {
      const response = await apiClient.post<PlayerResponse>('/players', data);
      return response.data;
    },
    onSuccess: () => {
      // Invalidate players list queries
      queryClient.invalidateQueries({ queryKey: playerKeys.lists() });
    },
  });
}

/**
 * Hook to update a player
 */
export function useUpdatePlayer() {
  const queryClient = useQueryClient();

  return useMutation<
    PlayerResponse,
    Error,
    { playerId: string; data: UpdatePlayerInput }
  >({
    mutationFn: async ({ playerId, data }) => {
      const response = await apiClient.patch<PlayerResponse>(
        `/players/${playerId}`,
        data
      );
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate specific player and list queries
      queryClient.invalidateQueries({
        queryKey: playerKeys.detail(variables.playerId),
      });
      queryClient.invalidateQueries({ queryKey: playerKeys.lists() });
    },
  });
}

/**
 * Hook to delete a player
 */
export function useDeletePlayer() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: async (playerId) => {
      const response = await apiClient.delete<{ success: boolean; message: string }>(
        `/players/${playerId}`
      );
      return response.data;
    },
    onSuccess: () => {
      // Invalidate all player queries
      queryClient.invalidateQueries({ queryKey: playerKeys.all });
    },
  });
}

