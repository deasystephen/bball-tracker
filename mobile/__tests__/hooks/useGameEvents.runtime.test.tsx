/**
 * Runtime tests for useGameEvents hooks.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useGameEvents,
  useGameEvent,
  useCreateGameEvent,
  useDeleteGameEvent,
  gameEventKeys,
} from '../../hooks/useGameEvents';
import { gameKeys } from '../../hooks/useGames';
import { apiClient } from '../../services/api-client';
import type { GameEventFilters } from '../../types/game';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

describe('useGameEvents runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches events for a game', async () => {
    const events = [{ id: 'e1' }];
    mockedGet.mockResolvedValueOnce({ data: { events } });

    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useGameEvents('g1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(events);
    expect(mockedGet).toHaveBeenCalledWith('/games/g1/events?');
  });

  it('serializes filters into the query string', async () => {
    mockedGet.mockResolvedValueOnce({ data: { events: [] } });
    const { wrapper } = createQueryWrapper();
    const filters = {
      eventType: 'SHOT',
      playerId: 'p1',
      limit: 5,
      offset: 10,
    } as unknown as GameEventFilters;
    const { result } = renderHook(() => useGameEvents('g1', filters), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = mockedGet.mock.calls[0][0] as string;
    expect(url).toContain('eventType=SHOT');
    expect(url).toContain('playerId=p1');
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=10');
  });

  it('useGameEvents is disabled without a gameId', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useGameEvents(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches a single game event', async () => {
    const event = { id: 'e1' };
    mockedGet.mockResolvedValueOnce({ data: { event } });

    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useGameEvent('g1', 'e1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(event);
    expect(mockedGet).toHaveBeenCalledWith('/games/g1/events/e1');
  });

  it('useGameEvent is disabled when either id is empty', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useGameEvent('g1', ''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('creates an event and invalidates list + game detail caches', async () => {
    const event = { id: 'e1' };
    mockedPost.mockResolvedValueOnce({ data: { event } });

    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateGameEvent(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        gameId: 'g1',
        data: { eventType: 'SHOT' } as unknown as Parameters<
          typeof result.current.mutateAsync
        >[0]['data'],
      });
    });

    expect(mockedPost).toHaveBeenCalledWith('/games/g1/events', { eventType: 'SHOT' });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameEventKeys.list('g1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameKeys.detail('g1'),
    });
  });

  it('deletes an event and invalidates list + game detail caches', async () => {
    mockedDelete.mockResolvedValueOnce({ data: {} });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteGameEvent(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ gameId: 'g1', eventId: 'e1' });
    });

    expect(mockedDelete).toHaveBeenCalledWith('/games/g1/events/e1');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameEventKeys.list('g1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameKeys.detail('g1'),
    });
  });
});
