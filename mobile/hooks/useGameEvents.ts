/**
 * React Query hooks for Game Events API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import type {
  Game,
  GameEvent,
  GameEventFilters,
  CreateGameEventInput,
} from '../types/game';
import { gameKeys } from './useGames';

export interface GameScore {
  homeScore: number;
  awayScore: number;
}

/** `POST /games/:id/events` response: the persisted event + post-change score. */
export interface CreateGameEventResult {
  event: GameEvent;
  score: GameScore;
}

/** `DELETE /games/:id/events/:eventId` response: the post-change score. */
export interface DeleteGameEventResult {
  score: GameScore;
}

/**
 * Write a server-authoritative score straight into the cached game detail so
 * the tracker/score header updates without waiting for the refetch.
 */
function applyScoreToGameDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  gameId: string,
  score: GameScore | undefined
): void {
  if (!score) return;
  queryClient.setQueryData<Game>(gameKeys.detail(gameId), (old) =>
    old ? { ...old, homeScore: score.homeScore, awayScore: score.awayScore } : old
  );
}

// Query keys
export const gameEventKeys = {
  all: ['gameEvents'] as const,
  lists: () => [...gameEventKeys.all, 'list'] as const,
  /**
   * Prefix matching every list query for one game regardless of filters.
   * Use this for invalidation: `list(gameId)` ends in `undefined`, which
   * TanStack's partial matcher does not treat as a wildcard (audit #76).
   */
  listsFor: (gameId: string) => [...gameEventKeys.lists(), gameId] as const,
  list: (gameId: string, filters?: GameEventFilters) =>
    [...gameEventKeys.listsFor(gameId), filters] as const,
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
    }): Promise<CreateGameEventResult> => {
      const response = await apiClient.post(`/games/${gameId}/events`, data);
      return {
        event: response.data.event as GameEvent,
        score: response.data.score as GameScore,
      };
    },
    onSuccess: (result, variables) => {
      // The home score is derived server-side from the event log (audit #6);
      // trust the returned score, then refetch for everything else.
      applyScoreToGameDetail(queryClient, variables.gameId, result.score);
      queryClient.invalidateQueries({
        queryKey: gameEventKeys.listsFor(variables.gameId),
      });
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
    }): Promise<DeleteGameEventResult> => {
      const response = await apiClient.delete(`/games/${gameId}/events/${eventId}`);
      return { score: response.data?.score as GameScore };
    },
    onSuccess: (result, variables) => {
      applyScoreToGameDetail(queryClient, variables.gameId, result.score);
      queryClient.invalidateQueries({
        queryKey: gameEventKeys.listsFor(variables.gameId),
      });
      queryClient.invalidateQueries({
        queryKey: gameKeys.detail(variables.gameId),
      });
    },
  });
}
