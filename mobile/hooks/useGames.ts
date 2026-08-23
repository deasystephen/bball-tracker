/**
 * React Query hooks for Games API
 */

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';
import { statsKeys } from './useStats';
import type {
  Game,
  GameFilters,
  CreateGameInput,
  UpdateGameInput,
  GameRsvp,
  RsvpStatus,
  RsvpSummary,
} from '../types/game';

// Query keys
export const gameKeys = {
  all: ['games'] as const,
  lists: () => [...gameKeys.all, 'list'] as const,
  list: (filters?: GameFilters) => [...gameKeys.lists(), filters] as const,
  infinite: (filters?: Omit<GameFilters, 'offset'>) =>
    [...gameKeys.lists(), 'infinite', filters] as const,
  live: () => [...gameKeys.lists(), 'live'] as const,
  details: () => [...gameKeys.all, 'detail'] as const,
  detail: (id: string) => [...gameKeys.details(), id] as const,
};

/** Default page size for paginated game lists (matches the server default). */
export const GAMES_PAGE_SIZE = 20;

export interface GamesPage {
  games: Game[];
  total: number;
  limit: number;
  offset: number;
}

async function fetchGamesPage(filters?: GameFilters): Promise<GamesPage> {
  const params = new URLSearchParams();
  if (filters?.teamId) params.append('teamId', filters.teamId);
  if (filters?.status) params.append('status', filters.status);
  if (filters?.startDate) params.append('startDate', filters.startDate);
  if (filters?.endDate) params.append('endDate', filters.endDate);
  if (filters?.limit) params.append('limit', filters.limit.toString());
  if (filters?.offset) params.append('offset', filters.offset.toString());

  const response = await apiClient.get(`/games?${params.toString()}`);
  const data = response.data as Partial<GamesPage>;
  const games = (data.games ?? []) as Game[];
  return {
    games,
    total: data.total ?? games.length,
    limit: data.limit ?? filters?.limit ?? GAMES_PAGE_SIZE,
    offset: data.offset ?? filters?.offset ?? 0,
  };
}

/**
 * Hook to fetch a single page of games (server-filtered). Returns only the
 * games array; use `useGamesPage` when you also need the server `total`.
 */
export function useGames(filters?: GameFilters) {
  return useQuery({
    queryKey: gameKeys.list(filters),
    queryFn: async () => (await fetchGamesPage(filters)).games,
  });
}

/**
 * Hook to fetch a single page of games including the server `total` count
 * (e.g. the Home "Upcoming" tile needs the count, not the rows).
 */
export function useGamesPage(filters?: GameFilters) {
  return useQuery({
    queryKey: [...gameKeys.list(filters), 'page'] as const,
    queryFn: () => fetchGamesPage(filters),
  });
}

/**
 * Infinite (paginated) games list. Filters (incl. `status`) are applied
 * server-side so a long backlog of scheduled games can never hide a live or
 * finished one. Feed `fetchNextPage` to `FlatList.onEndReached`.
 */
export function useInfiniteGames(filters?: Omit<GameFilters, 'offset'>) {
  const limit = filters?.limit ?? GAMES_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: gameKeys.infinite(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchGamesPage({ ...filters, limit, offset: pageParam }),
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.games.length;
      return lastPage.games.length < lastPage.limit || next >= lastPage.total ? undefined : next;
    },
    select: (data) => ({
      games: data.pages.flatMap((page) => page.games),
      total: data.pages[0]?.total ?? 0,
    }),
  });
}

/** Small limit for the Home live card: there is rarely more than one live game. */
export const LIVE_GAME_LIMIT = 5;

/**
 * Dedicated query for the Home "live game" card: asks the server for
 * IN_PROGRESS games only, so it is independent of how many scheduled games
 * sit ahead of it in the date-desc ordering.
 */
export function useLiveGames() {
  return useQuery({
    queryKey: gameKeys.live(),
    queryFn: async () =>
      (await fetchGamesPage({ status: 'IN_PROGRESS', limit: LIVE_GAME_LIMIT })).games,
    staleTime: 15_000,
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
      trackEvent(AnalyticsEvents.GAME_CREATED);
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
    onSuccess: (game, variables) => {
      trackEvent(AnalyticsEvents.GAME_UPDATED);
      queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
      queryClient.invalidateQueries({ queryKey: gameKeys.detail(variables.gameId) });
      // Season/player/box-score stats are finalized when a game ends; drop the
      // 10-minute stale cache so the Stats tab reflects the result immediately.
      if (variables.data.status === 'FINISHED' || game?.status === 'FINISHED') {
        queryClient.invalidateQueries({ queryKey: statsKeys.all });
      }
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
      trackEvent(AnalyticsEvents.GAME_DELETED);
      queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
    },
  });
}

// ============================================
// RSVP Hooks
// ============================================

export const rsvpKeys = {
  all: ['rsvps'] as const,
  game: (gameId: string) => [...rsvpKeys.all, gameId] as const,
};

/**
 * Hook to fetch RSVPs for a game
 */
export function useGameRsvps(gameId: string) {
  return useQuery({
    queryKey: rsvpKeys.game(gameId),
    queryFn: async () => {
      const response = await apiClient.get<{
        success: boolean;
        rsvps: GameRsvp[];
        summary: RsvpSummary;
      }>(`/games/${gameId}/rsvps`);
      return response.data;
    },
    enabled: !!gameId,
  });
}

/**
 * Hook to submit an RSVP
 */
export function useSubmitRsvp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ gameId, status }: { gameId: string; status: RsvpStatus }) => {
      const response = await apiClient.post<{ success: boolean; rsvp: GameRsvp }>(
        `/games/${gameId}/rsvp`,
        { status }
      );
      return response.data.rsvp;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: rsvpKeys.game(variables.gameId) });
    },
  });
}
