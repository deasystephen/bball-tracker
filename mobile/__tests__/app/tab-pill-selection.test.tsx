/**
 * Games tab filter pills and Stats tab team chips (#655, #772).
 *
 * Both rows are single-choice. The active pill is marked with
 * `accessibilityState.selected` (VoiceOver reads "selected"; Maestro asserts
 * `selected: true`), not only with its fill colour, and every pill is a 44pt
 * touch target.
 */

import { StyleSheet } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';

import GamesScreen from '../../app/(tabs)/games';
import StatsScreen from '../../app/(tabs)/stats';

const mockUseInfiniteGames = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTabBarPadding', () => ({ useTabBarPadding: () => 0 }));
jest.mock('../../hooks/useGames', () => ({
  useInfiniteGames: (...args: unknown[]) => mockUseInfiniteGames(...args),
}));
jest.mock('../../hooks/useTeams', () => ({
  TEAMS_MAX_LIMIT: 100,
  useTeams: () => ({
    data: [
      { id: 't1', name: 'Warriors' },
      { id: 't2', name: 'Lakers' },
    ],
    isLoading: false,
  }),
}));
jest.mock('../../hooks/useStats', () => ({
  useTeamSeasonStats: () => ({ data: undefined, isLoading: false }),
  useTeamRosterStats: () => ({ data: [], isLoading: false }),
}));

const selectedOf = (name: string): boolean | undefined =>
  screen.getByRole('button', { name }).props.accessibilityState?.selected;

const minHeightOf = (name: string): unknown =>
  StyleSheet.flatten(screen.getByRole('button', { name }).props.style).minHeight;

describe('Games tab filter pills', () => {
  beforeEach(() => {
    mockUseInfiniteGames.mockReturnValue({
      data: { games: [] },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
      isRefetching: false,
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
  });

  it('marks the active filter selected and moves the state on a press', () => {
    render(<GamesScreen />);

    expect(selectedOf('All')).toBe(true);
    expect(selectedOf('Upcoming')).toBe(false);

    fireEvent.press(screen.getByRole('button', { name: 'Upcoming' }));

    expect(selectedOf('Upcoming')).toBe(true);
    expect(selectedOf('All')).toBe(false);
    expect(selectedOf('Live')).toBe(false);
    expect(selectedOf('Completed')).toBe(false);
    expect(mockUseInfiniteGames).toHaveBeenLastCalledWith({ status: 'SCHEDULED' });
  });

  it('makes every pill a 44pt touch target', () => {
    render(<GamesScreen />);

    for (const name of ['All', 'Live', 'Upcoming', 'Completed']) {
      expect(minHeightOf(name)).toBe(44);
    }
  });
});

describe('Stats tab team chips', () => {
  it('marks the team being shown selected and moves the state on a press', () => {
    render(<StatsScreen />);

    expect(selectedOf('Warriors')).toBe(true);
    expect(selectedOf('Lakers')).toBe(false);

    fireEvent.press(screen.getByRole('button', { name: 'Lakers' }));

    expect(selectedOf('Lakers')).toBe(true);
    expect(selectedOf('Warriors')).toBe(false);
  });

  it('makes every chip a 44pt touch target', () => {
    render(<StatsScreen />);

    expect(minHeightOf('Warriors')).toBe(44);
    expect(minHeightOf('Lakers')).toBe(44);
  });
});
