/**
 * `useRolloverTeam` (#461): posts the rollover, resolves with the new
 * team-season and `created`, fires `team_rolled_over` (ids and flags only),
 * and refreshes the team list, the usage meter and the season lists.
 */

import { renderHook, act } from '@testing-library/react-native';

import { useRolloverTeam, teamKeys, type Team } from '../../hooks/useTeams';
import { usageKeys } from '../../hooks/useUsage';
import { seasonKeys } from '../../hooks/useSeasons';
import { apiClient } from '../../services/api-client';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';
import { createQueryWrapper } from '../utils/queryWrapper';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedPost = apiClient.post as jest.Mock;
const mockedTrack = trackEvent as jest.Mock;

const nextTeam: Team = {
  id: 't2',
  name: 'Hawks',
  seasonId: 's2',
  createdAt: '2027-01-01',
  updatedAt: '2027-01-01',
};

beforeEach(() => jest.clearAllMocks());

describe('useRolloverTeam', () => {
  it('posts a named season, tracks the event and invalidates lists, usage and seasons', async () => {
    mockedPost.mockResolvedValueOnce({ data: { success: true, created: true, team: nextTeam } });
    const { wrapper, client } = createQueryWrapper();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useRolloverTeam(), { wrapper });

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync({ teamId: 't1', data: { seasonName: '2027', ageGroup: 'U13' } });
    });

    expect(mockedPost).toHaveBeenCalledWith('/teams/t1/rollover', { seasonName: '2027', ageGroup: 'U13' });
    expect(resolved).toEqual({ team: nextTeam, created: true });
    expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.TEAM_ROLLED_OVER, {
      team_id: 't2',
      from_team_id: 't1',
      created: true,
      new_season: true,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: usageKeys.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: seasonKeys.lists() });
  });

  it('reports a repeat (created: false) on a picked season', async () => {
    mockedPost.mockResolvedValueOnce({ data: { success: true, created: false, team: nextTeam } });
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useRolloverTeam(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ teamId: 't1', data: { seasonId: 's2' } });
    });

    expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.TEAM_ROLLED_OVER, {
      team_id: 't2',
      from_team_id: 't1',
      created: false,
      new_season: false,
    });
  });
});
