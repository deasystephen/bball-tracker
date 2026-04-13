/**
 * Runtime tests for useSeasons hooks.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useSeasons,
  useSeason,
  useCreateSeason,
  useUpdateSeason,
  useDeleteSeason,
  seasonKeys,
} from '../../hooks/useSeasons';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

describe('useSeasons runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches seasons list without filters', async () => {
    const payload = { success: true, seasons: [], total: 0, limit: 0, offset: 0 };
    mockedGet.mockResolvedValueOnce({ data: payload });

    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSeasons(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
    expect(mockedGet).toHaveBeenCalledWith('/seasons?');
  });

  it('serializes all filter params', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, seasons: [], total: 0, limit: 0, offset: 0 },
    });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(
      () =>
        useSeasons({
          leagueId: 'l1',
          isActive: false,
          search: 'spring',
          limit: 5,
          offset: 10,
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = mockedGet.mock.calls[0][0] as string;
    expect(url).toContain('leagueId=l1');
    expect(url).toContain('isActive=false');
    expect(url).toContain('search=spring');
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=10');
  });

  it('fetches a single season by id', async () => {
    const season = { id: 's1', name: 'Spring' };
    mockedGet.mockResolvedValueOnce({ data: { success: true, season } });

    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSeason('s1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(season);
    expect(mockedGet).toHaveBeenCalledWith('/seasons/s1');
  });

  it('useSeason is disabled without id', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSeason(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('creates a season and invalidates list + parent league detail', async () => {
    const season = { id: 's1', leagueId: 'l1' };
    mockedPost.mockResolvedValueOnce({ data: { success: true, season } });

    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateSeason(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ leagueId: 'l1', name: 'Spring' });
    });

    expect(mockedPost).toHaveBeenCalledWith('/seasons', {
      leagueId: 'l1',
      name: 'Spring',
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: seasonKeys.lists() });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['leagues', 'detail', 'l1'],
    });
  });

  it('updates a season and invalidates list + detail caches', async () => {
    const season = { id: 's1', leagueId: 'l1' };
    mockedPatch.mockResolvedValueOnce({ data: { success: true, season } });

    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateSeason(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        seasonId: 's1',
        data: { name: 'Renamed' },
      });
    });

    expect(mockedPatch).toHaveBeenCalledWith('/seasons/s1', { name: 'Renamed' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: seasonKeys.lists() });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: seasonKeys.detail('s1'),
    });
  });

  it('deletes a season and invalidates lists', async () => {
    mockedDelete.mockResolvedValueOnce({ data: {} });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteSeason(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('s1');
    });

    expect(mockedDelete).toHaveBeenCalledWith('/seasons/s1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: seasonKeys.lists() });
  });
});
