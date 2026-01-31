/**
 * React Query hooks for Game Events API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import type {
  GameEvent,
  GameEventFilters,
  CreateGameEventInput,
} from '../types/game';
import { gameKeys } from './useGames';

// Query keys
export const gameEventKeys = {
  all: ['gameEvents'] as const,
  lists: () => [...gameEventKeys.all, 'list'] as const,
  list: (gameId: string, filters?: GameEventFilters) =>
    [...gameEventKeys.lists(), gameId, filters] as const,
  details: () => [...gameEventKeys.all, 'detail'] as const,
  detail: (gameId: string, eventId: string) =>
    [...gameEventKeys.details(), gameId, eventId] as const,
};

/**
 * Hook to fetch events for a game
 */
export function useGameEvents(gameId: string, filters?: GameEventFilters) {
  return useQuery({
    queryKey: gameEventKeys.list(gameId, filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.eventType) params.append('eventType', filters.eventType);
      if (filters?.playerId) params.append('playerId', filters.playerId);
      if (filters?.limit) params.append('limit', filters.limit.toString());
      if (filters?.offset) params.append('offset', filters.offset.toString());

      const response = await apiClient.get(
        `/games/${gameId}/events?${params.toString()}`
      );
      return response.data.events as GameEvent[];
    },
    enabled: !!gameId,
  });
}

/**
 * Hook to fetch a single game event
 */
export function useGameEvent(gameId: string, eventId: string) {
  return useQuery({
    queryKey: gameEventKeys.detail(gameId, eventId),
    queryFn: async () => {
      const response = await apiClient.get(`/games/${gameId}/events/${eventId}`);
      return response.data.event as GameEvent;
    },
    enabled: !!gameId && !!eventId,
  });
}

/**
 * Hook to create a game event
 */
export function useCreateGameEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      gameId,
      data,
    }: {
      gameId: string;
      data: CreateGameEventInput;
    }) => {
      const response = await apiClient.post(`/games/${gameId}/events`, data);
      return response.data.event as GameEvent;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: gameEventKeys.list(variables.gameId),
      });
      // Also invalidate game detail to update scores if needed
      queryClient.invalidateQueries({
        queryKey: gameKeys.detail(variables.gameId),
      });
    },
  });
}

/**
 * Hook to delete a game event
 */
export function useDeleteGameEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      gameId,
      eventId,
    }: {
      gameId: string;
      eventId: string;
    }) => {
      await apiClient.delete(`/games/${gameId}/events/${eventId}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: gameEventKeys.list(variables.gameId),
      });
      // Also invalidate game detail to update scores if needed
      queryClient.invalidateQueries({
        queryKey: gameKeys.detail(variables.gameId),
      });
    },
  });
}
