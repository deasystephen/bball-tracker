/**
 * Runtime tests for useStats hooks.
 */

import { renderHook, waitFor } from '@testing-library/react-native';

import {
  useBoxScore,
  usePlayerGameStats,
  usePlayerOverallStats,
  usePlayerSeasonStats,
  useTeamSeasonStats,
  useTeamRosterStats,
} from '../../hooks/useStats';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;

describe('useStats runtime', () => {
  beforeEach(() => jest.clearAllMocks());

  it('useBoxScore fetches box score for a game', async () => {
    const boxScore = { gameId: 'g1', home: {}, away: {} };
    mockedGet.mockResolvedValueOnce({ data: { boxScore } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useBoxScore('g1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(boxScore);
    expect(mockedGet).toHaveBeenCalledWith('/stats/games/g1');
  });

  it('useBoxScore is disabled without gameId', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useBoxScore(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('usePlayerGameStats fetches player stats for a game', async () => {
    const stats = { points: 10 };
    mockedGet.mockResolvedValueOnce({ data: { stats } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerGameStats('g1', 'p1'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stats);
    expect(mockedGet).toHaveBeenCalledWith('/stats/games/g1/players/p1');
  });

  it('usePlayerGameStats is disabled when either id missing', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerGameStats('', 'p1'), {
      wrapper,
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('usePlayerOverallStats returns combined shape', async () => {
    const response = {
      player: { id: 'p1' },
      teams: [{ id: 't1' }],
      careerTotals: { points: 100 },
    };
    mockedGet.mockResolvedValueOnce({ data: response });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerOverallStats('p1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(mockedGet).toHaveBeenCalledWith('/stats/players/p1');
  });

  it('usePlayerSeasonStats fetches season aggregate', async () => {
    const stats = { gamesPlayed: 3 };
    mockedGet.mockResolvedValueOnce({ data: { stats } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => usePlayerSeasonStats('p1', 't1'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stats);
    expect(mockedGet).toHaveBeenCalledWith('/stats/players/p1/teams/t1');
  });

  it('useTeamSeasonStats fetches team season stats', async () => {
    const stats = { wins: 5 };
    mockedGet.mockResolvedValueOnce({ data: { stats } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTeamSeasonStats('t1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stats);
    expect(mockedGet).toHaveBeenCalledWith('/stats/teams/t1');
  });

  it('useTeamSeasonStats is disabled without teamId', () => {
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTeamSeasonStats(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('useTeamRosterStats returns the players array', async () => {
    const players = [{ playerId: 'p1' }, { playerId: 'p2' }];
    mockedGet.mockResolvedValueOnce({ data: { players } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useTeamRosterStats('t1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(players);
    expect(mockedGet).toHaveBeenCalledWith('/stats/teams/t1/players');
  });
});
