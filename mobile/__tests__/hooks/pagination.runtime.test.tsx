/**
 * Runtime tests for the paginated / infinite list hooks and the cross-domain
 * cache invalidations added for audit #30 / #35 / #63:
 *
 * - `useInfiniteGames` / `useInfiniteTeams` / `useInfiniteAnnouncements`
 *   page through `limit`/`offset`, stop when the server `total` is reached,
 *   and flatten pages for the UI.
 * - `useLiveGames` asks the server for IN_PROGRESS games only.
 * - `useUpdateGame` invalidates stats when a game is marked FINISHED.
 * - `useCreateTeam` / `useDeleteTeam` invalidate the usage meter.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useInfiniteGames,
  useLiveGames,
  useGamesPage,
  useUpdateGame,
  gameKeys,
  GAMES_PAGE_SIZE,
  LIVE_GAME_LIMIT,
} from '../../hooks/useGames';
import {
  useInfiniteTeams,
  useCreateTeam,
  useDeleteTeam,
  teamKeys,
  TEAMS_PAGE_SIZE,
} from '../../hooks/useTeams';
import {
  useInfiniteAnnouncements,
  useCreateAnnouncement,
  announcementKeys,
} from '../../hooks/useAnnouncements';
import { statsKeys } from '../../hooks/useStats';
import { usageKeys } from '../../hooks/useUsage';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

function queryParams(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1] ?? '');
}

describe('pagination runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useInfiniteGames', () => {
    it('applies the status filter server-side and pages with limit/offset until total is reached', async () => {
      const page1 = Array.from({ length: GAMES_PAGE_SIZE }, (_, i) => ({
        id: `g${i}`,
        status: 'SCHEDULED',
      }));
      const page2 = [{ id: 'g20', status: 'SCHEDULED' }];
      mockedGet
        .mockResolvedValueOnce({
          data: { games: page1, total: 21, limit: GAMES_PAGE_SIZE, offset: 0 },
        })
        .mockResolvedValueOnce({
          data: { games: page2, total: 21, limit: GAMES_PAGE_SIZE, offset: GAMES_PAGE_SIZE },
        });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteGames({ status: 'SCHEDULED' }), {
        wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.games).toHaveLength(GAMES_PAGE_SIZE);
      expect(result.current.data?.total).toBe(21);
      expect(result.current.hasNextPage).toBe(true);

      const firstParams = queryParams(mockedGet.mock.calls[0][0] as string);
      expect(firstParams.get('status')).toBe('SCHEDULED');
      expect(firstParams.get('limit')).toBe(String(GAMES_PAGE_SIZE));
      expect(firstParams.get('offset')).toBeNull(); // offset 0 is omitted

      await act(async () => {
        await result.current.fetchNextPage();
      });

      await waitFor(() => expect(result.current.data?.games).toHaveLength(21));
      const secondParams = queryParams(mockedGet.mock.calls[1][0] as string);
      expect(secondParams.get('status')).toBe('SCHEDULED');
      expect(secondParams.get('offset')).toBe(String(GAMES_PAGE_SIZE));
      expect(result.current.hasNextPage).toBe(false);
    });

    it('has no next page when the first page is short', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { games: [{ id: 'g1' }], total: 1, limit: GAMES_PAGE_SIZE, offset: 0 },
      });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteGames(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.hasNextPage).toBe(false);
      expect(queryParams(mockedGet.mock.calls[0][0] as string).get('status')).toBeNull();
    });

    it('is keyed under gameKeys.lists() so list invalidations cover it', () => {
      expect(gameKeys.infinite({ status: 'FINISHED' }).slice(0, 2)).toEqual(gameKeys.lists());
      expect(gameKeys.live().slice(0, 2)).toEqual(gameKeys.lists());
    });
  });

  describe('useLiveGames', () => {
    it('requests IN_PROGRESS games only with a small limit', async () => {
      const live = [{ id: 'live1', status: 'IN_PROGRESS' }];
      mockedGet.mockResolvedValueOnce({ data: { games: live, total: 1 } });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useLiveGames(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(live);
      const params = queryParams(mockedGet.mock.calls[0][0] as string);
      expect(params.get('status')).toBe('IN_PROGRESS');
      expect(params.get('limit')).toBe(String(LIVE_GAME_LIMIT));
    });
  });

  describe('useGamesPage', () => {
    it('returns the server total alongside the page', async () => {
      mockedGet.mockResolvedValueOnce({
        data: { games: [{ id: 'g1' }], total: 42, limit: 1, offset: 0 },
      });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGamesPage({ status: 'SCHEDULED', limit: 1 }), {
        wrapper,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.total).toBe(42);
      expect(result.current.data?.games).toHaveLength(1);
    });
  });

  describe('useUpdateGame stats invalidation (#35)', () => {
    it('invalidates statsKeys.all when the game is marked FINISHED', async () => {
      mockedPatch.mockResolvedValueOnce({ data: { game: { id: 'g1', status: 'FINISHED' } } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useUpdateGame(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ gameId: 'g1', data: { status: 'FINISHED' } });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: statsKeys.all });
    });

    it('does not touch stats for a non-terminal update', async () => {
      mockedPatch.mockResolvedValueOnce({ data: { game: { id: 'g1', status: 'IN_PROGRESS' } } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useUpdateGame(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ gameId: 'g1', data: { homeScore: 10 } });
      });

      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: statsKeys.all });
    });
  });

  describe('useInfiniteTeams', () => {
    it('pages through teams and exposes the server total', async () => {
      const page1 = Array.from({ length: TEAMS_PAGE_SIZE }, (_, i) => ({
        id: `t${i}`,
        name: `Team ${i}`,
      }));
      mockedGet
        .mockResolvedValueOnce({
          data: { success: true, teams: page1, total: 25, limit: TEAMS_PAGE_SIZE, offset: 0 },
        })
        .mockResolvedValueOnce({
          data: {
            success: true,
            teams: [{ id: 't20', name: 'Team 20' }],
            total: 25,
            limit: TEAMS_PAGE_SIZE,
            offset: TEAMS_PAGE_SIZE,
          },
        });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteTeams(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.total).toBe(25);
      expect(result.current.hasNextPage).toBe(true);

      await act(async () => {
        await result.current.fetchNextPage();
      });

      await waitFor(() => expect(result.current.data?.teams).toHaveLength(21));
      expect(queryParams(mockedGet.mock.calls[1][0] as string).get('offset')).toBe(
        String(TEAMS_PAGE_SIZE)
      );
      // Short second page => done, even though total says more.
      expect(result.current.hasNextPage).toBe(false);
    });

    it('is keyed under teamKeys.lists() so list invalidations cover it', () => {
      expect(teamKeys.infinite().slice(0, 2)).toEqual(teamKeys.lists());
    });
  });

  describe('usage invalidation on team create/delete (#63)', () => {
    it('useCreateTeam invalidates the usage meter', async () => {
      mockedPost.mockResolvedValueOnce({ data: { team: { id: 't1' } } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useCreateTeam(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ name: 'Hawks', seasonId: 's1' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: usageKeys.all });
    });

    it('useDeleteTeam invalidates the usage meter', async () => {
      mockedDelete.mockResolvedValueOnce({});
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useDeleteTeam(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync('t1');
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: usageKeys.all });
    });
  });

  describe('useInfiniteAnnouncements', () => {
    it('pages with limit/offset and stops at total', async () => {
      const page1 = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}` }));
      mockedGet
        .mockResolvedValueOnce({ data: { success: true, announcements: page1, total: 21 } })
        .mockResolvedValueOnce({
          data: { success: true, announcements: [{ id: 'a20' }], total: 21 },
        });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteAnnouncements('t1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/announcements?limit=20&offset=0');
      expect(result.current.hasNextPage).toBe(true);

      await act(async () => {
        await result.current.fetchNextPage();
      });

      await waitFor(() => expect(result.current.data?.announcements).toHaveLength(21));
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/announcements?limit=20&offset=20');
      expect(result.current.hasNextPage).toBe(false);
    });

    it('is disabled without a teamId', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteAnnouncements(''), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('is refetched by the create-announcement invalidation', async () => {
      mockedGet.mockResolvedValue({
        data: { success: true, announcements: [], total: 0 },
      });
      mockedPost.mockResolvedValueOnce({ data: { announcement: { id: 'a1' } } });
      const { wrapper, client } = createQueryWrapper();
      const { result: list } = renderHook(() => useInfiniteAnnouncements('t1'), { wrapper });
      await waitFor(() => expect(list.current.isSuccess).toBe(true));
      expect(mockedGet).toHaveBeenCalledTimes(1);

      const { result: create } = renderHook(() => useCreateAnnouncement(), { wrapper });
      await act(async () => {
        await create.current.mutateAsync({ teamId: 't1', data: { title: 'x', body: 'y' } });
      });

      await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
      expect(
        client.getQueryState(announcementKeys.teamInfinite('t1'))?.dataUpdateCount
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
