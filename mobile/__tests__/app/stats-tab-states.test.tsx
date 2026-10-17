/**
 * Stats tab: a failed request is not an empty result (#728).
 *
 * The tab read only `data` and `isLoading`, so a failed teams fetch showed
 * "No Teams Yet" and a failed team-stats fetch showed "No Statistics Yet",
 * with no way to retry. Failures now render `ErrorState` with Try Again; the
 * two empty states are kept for genuine zero-row answers.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import Stats from '../../app/(tabs)/stats';
import type { TeamSeasonStats } from '../../types/stats';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };

interface MockQuery {
  data?: unknown;
  isLoading: boolean;
  error: unknown;
  refetch: jest.Mock;
}
let mockTeamsQuery: MockQuery;
let mockSeasonQuery: MockQuery;
let mockRosterQuery: MockQuery;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../hooks/useStats', () => ({
  ...jest.requireActual('../../hooks/useStats'),
  useTeamSeasonStats: () => mockSeasonQuery,
  useTeamRosterStats: () => mockRosterQuery,
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeams: () => mockTeamsQuery,
}));

const TEAMS = [
  { id: 'team-1', name: 'Wildcats' },
  { id: 'team-2', name: 'Hornets' },
];

function seasonStats(overrides: Partial<TeamSeasonStats> = {}): TeamSeasonStats {
  return {
    teamId: 'team-1',
    teamName: 'Wildcats',
    gamesPlayed: 0,
    trackedGames: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsPerGame: 0,
    reboundsPerGame: 0,
    assistsPerGame: 0,
    turnoversPerGame: 0,
    fieldGoalPercentage: 0,
    threePointPercentage: 0,
    freeThrowPercentage: 0,
    recentGames: [],
    ...overrides,
  };
}

function query(data: unknown): MockQuery {
  return { data, isLoading: false, error: null, refetch: jest.fn() };
}

function failed(message: string): MockQuery {
  return { data: undefined, isLoading: false, error: new Error(message), refetch: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTeamsQuery = query(TEAMS);
  mockSeasonQuery = query(seasonStats());
  mockRosterQuery = query([]);
});

describe('Stats tab — load states', () => {
  it('shows the error with Try Again, not "No Teams Yet", when the teams request fails', () => {
    mockTeamsQuery = failed('Network Error');
    const view = render(<Stats />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText('Network Error')).toBeTruthy();
    expect(view.getByText('Statistics')).toBeTruthy();
    expect(view.queryByText('No Teams Yet')).toBeNull();

    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockTeamsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the error under the team chips, not "No Statistics Yet", when the season stats fail', () => {
    mockSeasonQuery = failed('Request failed with status code 500');
    const view = render(<Stats />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText('Request failed with status code 500')).toBeTruthy();
    expect(view.queryByText('No Statistics Yet')).toBeNull();

    // The chips stay, so another team can be picked.
    expect(view.getByText('Wildcats')).toBeTruthy();
    expect(view.getByText('Hornets')).toBeTruthy();

    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockSeasonQuery.refetch).toHaveBeenCalledTimes(1);
    expect(mockRosterQuery.refetch).not.toHaveBeenCalled();
  });

  it('shows the error with Try Again when the roster stats fail', () => {
    mockRosterQuery = failed('Network Error');
    const view = render(<Stats />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.queryByText('No Statistics Yet')).toBeNull();
    expect(view.getByText('Hornets')).toBeTruthy();

    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockRosterQuery.refetch).toHaveBeenCalledTimes(1);
    expect(mockSeasonQuery.refetch).not.toHaveBeenCalled();
  });

  it('keeps "No Teams Yet" for a successful empty teams list', () => {
    mockTeamsQuery = query([]);
    const view = render(<Stats />);

    expect(view.getByText('No Teams Yet')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it('keeps "No Statistics Yet" for a team with no games played', () => {
    const view = render(<Stats />);

    expect(view.getByText('No Statistics Yet')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it('keeps the cached teams on screen when only a background refetch failed', () => {
    mockTeamsQuery = { ...query(TEAMS), error: new Error('Network Error') };
    const view = render(<Stats />);

    expect(view.getByText('Wildcats')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });
});
