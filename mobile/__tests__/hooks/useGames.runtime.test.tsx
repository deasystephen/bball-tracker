/**
 * Runtime tests for useGames hooks.
 *
 * Exercises the actual React Query hook execution, asserting that
 * query functions call the expected apiClient endpoint, return the
 * shape the UI consumes, and that mutations invalidate the correct
 * caches.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useGames,
  useGame,
  useCreateGame,
  useUpdateGame,
  useDeleteGame,
  useGameRsvps,
  useSubmitRsvp,
  gameKeys,
  rsvpKeys,
} from '../../hooks/useGames';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

describe('useGames runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useGames query', () => {
    it('fetches list of games and returns data', async () => {
      const games = [{ id: 'g1', name: 'Game 1' }];
      mockedGet.mockResolvedValueOnce({ data: { games } });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGames(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(games);
      expect(mockedGet).toHaveBeenCalledWith('/games?');
    });

    it('serializes filters into the query string', async () => {
      mockedGet.mockResolvedValueOnce({ data: { games: [] } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () =>
          useGames({
            teamId: 't1',
            status: 'SCHEDULED',
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            limit: 10,
            offset: 20,
          }),
        { wrapper }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = mockedGet.mock.calls[0][0] as string;
      expect(url).toContain('teamId=t1');
      expect(url).toContain('status=SCHEDULED');
      expect(url).toContain('startDate=2026-01-01');
      expect(url).toContain('endDate=2026-12-31');
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=20');
    });

    it('surfaces errors when the request fails', async () => {
      mockedGet.mockRejectedValueOnce(new Error('boom'));
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGames(), { wrapper });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect((result.current.error as Error).message).toBe('boom');
    });
  });

  describe('useGame query', () => {
    it('fetches a single game by id', async () => {
      const game = { id: 'g1', name: 'Game 1' };
      mockedGet.mockResolvedValueOnce({ data: { game } });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGame('g1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(game);
      expect(mockedGet).toHaveBeenCalledWith('/games/g1');
    });

    it('is disabled when gameId is empty', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGame(''), { wrapper });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });
  });

  describe('useCreateGame mutation', () => {
    it('posts and invalidates games list on success', async () => {
      const created = { id: 'g1', name: 'New' };
      mockedPost.mockResolvedValueOnce({ data: { game: created } });

      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useCreateGame(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({
          name: 'New',
          teamId: 't1',
          scheduledAt: '2026-05-01T00:00:00Z',
        } as unknown as Parameters<typeof result.current.mutateAsync>[0]);
      });

      expect(mockedPost).toHaveBeenCalledWith(
        '/games',
        expect.objectContaining({ name: 'New' })
      );
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: gameKeys.lists() });
    });
  });

  describe('useUpdateGame mutation', () => {
    it('patches and invalidates list + detail caches', async () => {
      const updated = { id: 'g1', name: 'Updated' };
      mockedPatch.mockResolvedValueOnce({ data: { game: updated } });

      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useUpdateGame(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({
          gameId: 'g1',
          data: { name: 'Updated' } as unknown as Parameters<
            typeof result.current.mutateAsync
          >[0]['data'],
        });
      });

      expect(mockedPatch).toHaveBeenCalledWith('/games/g1', { name: 'Updated' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: gameKeys.lists() });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: gameKeys.detail('g1'),
      });
    });
  });

  describe('useDeleteGame mutation', () => {
    it('deletes and invalidates games list', async () => {
      mockedDelete.mockResolvedValueOnce({ data: {} });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useDeleteGame(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync('g1');
      });

      expect(mockedDelete).toHaveBeenCalledWith('/games/g1');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: gameKeys.lists() });
    });
  });

  describe('useGameRsvps query', () => {
    it('fetches rsvps for a game', async () => {
      const payload = {
        success: true,
        rsvps: [{ id: 'r1' }],
        summary: { going: 1, notGoing: 0, maybe: 0 },
      };
      mockedGet.mockResolvedValueOnce({ data: payload });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGameRsvps('g1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(payload);
      expect(mockedGet).toHaveBeenCalledWith('/games/g1/rsvps');
    });

    it('is disabled without a gameId', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useGameRsvps(''), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
    });
  });

  describe('useSubmitRsvp mutation', () => {
    it('submits an rsvp and invalidates that game rsvps cache', async () => {
      const rsvp = { id: 'r1', status: 'GOING' };
      mockedPost.mockResolvedValueOnce({ data: { success: true, rsvp } });

      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useSubmitRsvp(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({
          gameId: 'g1',
          status: 'GOING' as unknown as Parameters<
            typeof result.current.mutateAsync
          >[0]['status'],
        });
      });

      expect(mockedPost).toHaveBeenCalledWith('/games/g1/rsvp', { status: 'GOING' });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: rsvpKeys.game('g1'),
      });
    });
  });
});
