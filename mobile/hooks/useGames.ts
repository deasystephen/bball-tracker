/**
 * React Query hooks for Games API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import type {
  Game,
  GameFilters,
  CreateGameInput,
  UpdateGameInput,
} from '../types/game';

// Query keys
export const gameKeys = {
  all: ['games'] as const,
  lists: () => [...gameKeys.all, 'list'] as const,
  list: (filters?: GameFilters) => [...gameKeys.lists(), filters] as const,
  details: () => [...gameKeys.all, 'detail'] as const,
  detail: (id: string) => [...gameKeys.details(), id] as const,
};

/**
 * Hook to fetch list of games
 */
export function useGames(filters?: GameFilters) {
  return useQuery({
    queryKey: gameKeys.list(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.teamId) params.append('teamId', filters.teamId);
      if (filters?.status) params.append('status', filters.status);
      if (filters?.startDate) params.append('startDate', filters.startDate);
      if (filters?.endDate) params.append('endDate', filters.endDate);
      if (filters?.limit) params.append('limit', filters.limit.toString());
      if (filters?.offset) params.append('offset', filters.offset.toString());

      const response = await apiClient.get(`/games?${params.toString()}`);
      return response.data.games as Game[];
    },
  });
}

/**
 * Hook to fetch a single game by ID
 */
export function useGame(gameId: string) {
  return useQuery({
    queryKey: gameKeys.detail(gameId),
    queryFn: async () => {
      const response = await apiClient.get(`/games/${gameId}`);
      return response.data.game as Game;
    },
    enabled: !!gameId,
  });
}

/**
 * Hook to create a new game
 */
export function useCreateGame() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateGameInput) => {
      const response = await apiClient.post('/games', data);
      return response.data.game as Game;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
    },
  });
}

/**
 * Hook to update a game
 */
export function useUpdateGame() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ gameId, data }: { gameId: string; data: UpdateGameInput }) => {
      const response = await apiClient.patch(`/games/${gameId}`, data);
      return response.data.game as Game;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
      queryClient.invalidateQueries({ queryKey: gameKeys.detail(variables.gameId) });
    },
  });
}

/**
 * Hook to delete a game
 */
export function useDeleteGame() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (gameId: string) => {
      await apiClient.delete(`/games/${gameId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
    },
  });
}
