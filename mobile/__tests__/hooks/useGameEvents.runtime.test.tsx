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

  it('creates an event, returns event + server score, writes the score into the game cache and invalidates', async () => {
    const event = { id: 'e1' };
    const score = { homeScore: 12, awayScore: 7 };
    mockedPost.mockResolvedValueOnce({ data: { event, score } });

    const { wrapper, client } = createQueryWrapper();
    client.setQueryData(gameKeys.detail('g1'), { id: 'g1', homeScore: 0, awayScore: 7, opponent: 'X' });
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateGameEvent(), { wrapper });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutateAsync({
        gameId: 'g1',
        data: { eventType: 'SHOT' } as unknown as Parameters<
          typeof result.current.mutateAsync
        >[0]['data'],
      });
    });

    expect(mockedPost).toHaveBeenCalledWith('/games/g1/events', { eventType: 'SHOT' });
    expect(returned).toEqual({ event, score });
    expect(client.getQueryData(gameKeys.detail('g1'))).toMatchObject({
      id: 'g1',
      opponent: 'X',
      homeScore: 12,
      awayScore: 7,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameEventKeys.list('g1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameKeys.detail('g1'),
    });
  });

  it('deletes an event, writes the returned score into the game cache and invalidates', async () => {
    mockedDelete.mockResolvedValueOnce({ data: { success: true, score: { homeScore: 10, awayScore: 7 } } });
    const { wrapper, client } = createQueryWrapper();
    client.setQueryData(gameKeys.detail('g1'), { id: 'g1', homeScore: 12, awayScore: 7 });
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteGameEvent(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ gameId: 'g1', eventId: 'e1' });
    });

    expect(mockedDelete).toHaveBeenCalledWith('/games/g1/events/e1');
    expect(client.getQueryData(gameKeys.detail('g1'))).toMatchObject({ homeScore: 10, awayScore: 7 });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameEventKeys.list('g1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: gameKeys.detail('g1'),
    });
  });

  it('leaves the game cache untouched when the create response has no score', async () => {
    mockedPost.mockResolvedValueOnce({ data: { event: { id: 'e1' } } });
    const { wrapper, client } = createQueryWrapper();
    client.setQueryData(gameKeys.detail('g1'), { id: 'g1', homeScore: 4, awayScore: 1 });
    const { result } = renderHook(() => useCreateGameEvent(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        gameId: 'g1',
        data: { eventType: 'TIMEOUT' } as unknown as Parameters<
          typeof result.current.mutateAsync
        >[0]['data'],
      });
    });

    expect(client.getQueryData(gameKeys.detail('g1'))).toMatchObject({ homeScore: 4, awayScore: 1 });
  });
});
