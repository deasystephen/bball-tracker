/**
 * Home — the "Your Teams" pills (#655 review). Each pill is a button labelled
 * "<team>, <n> players", and the count is a real plural: one team with one
 * player reads "1 player", never "1 players". Renders the real i18n instance.
 */

import { render, screen } from '@testing-library/react-native';

import Home from '../../app/(tabs)/home';
import { useAuthStore } from '../../store/auth-store';

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }) }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const query = (data: unknown) => ({ data, isLoading: false, isRefetching: false, refetch: jest.fn() });

jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useInfiniteTeams: () =>
    query({
      teams: [
        { id: 't1', name: 'Warriors', _count: { members: 1 } },
        { id: 't2', name: 'Lakers', _count: { members: 8 } },
      ],
      total: 2,
    }),
}));
jest.mock('../../hooks/useGames', () => ({
  useLiveGames: () => query([]),
  useGames: () => query([]),
  useGamesPage: () => query({ games: [], total: 0 }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  useInvitations: () => query({ invitations: [] }),
}));

describe('Home team pills', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'frank', role: 'COACH', email: 'frank.vogel@example.com', name: 'Frank Vogel' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  it('labels each pill "<team>, <n> players" with a singular for one player', () => {
    render(<Home />);

    expect(screen.getByRole('button', { name: 'Warriors, 1 player' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lakers, 8 players' })).toBeTruthy();
  });

  it('shows the same plural in the visible count', () => {
    render(<Home />);

    expect(screen.getByText('1 player')).toBeTruthy();
    expect(screen.getByText('8 players')).toBeTruthy();
    expect(screen.queryByText('1 players')).toBeNull();
  });
});
