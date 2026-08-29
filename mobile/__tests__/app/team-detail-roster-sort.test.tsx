/**
 * Team overview roster ordering: jersey order by default (0 valid, nulls
 * last), a "Sort by Name" pill reorders, and the choice persists per user
 * (AsyncStorage `rosterSort:<userId>`, hydrated on the next visit).
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import TeamDetailsScreen from '../../app/teams/[id]';
import { useAuthStore } from '../../store/auth-store';
import { rosterSortStorageKey } from '../../hooks/useRosterSortPreference';
import type { Team, TeamStaff } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockTeam: Team | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
  useDeleteTeam: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const headRole: TeamStaff['role'] = {
  id: 'r-head',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

const makeMember = (playerId: string, name: string, jerseyNumber: number | null) => ({
  id: `m-${playerId}`,
  playerId,
  jerseyNumber,
  position: null,
  player: { id: playerId, name, isManaged: false, email: null },
});

const baseTeam = (): Team => ({
  id: 't1',
  name: 'Spartans 5/6',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  staff: [
    { id: 'ts-coach', userId: 'coach-1', user: { id: 'coach-1', name: 'Coach' }, role: headRole },
  ],
  members: [
    makeMember('p-null', 'Bob NoNumber', null),
    makeMember('p-five', 'Amy Five', 5),
    makeMember('p-zero', 'Zed Zero', 0),
  ],
  invitations: [],
});

const signIn = () => {
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'x@y.z', name: 'X' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

/** Names in on-screen order, derived from the rendered tree. */
const renderedOrder = (screen: ReturnType<typeof render>): string[] => {
  const json = JSON.stringify(screen.toJSON());
  return ['Bob NoNumber', 'Amy Five', 'Zed Zero'].sort(
    (a, b) => json.indexOf(a) - json.indexOf(b)
  );
};

describe('TeamDetailsScreen — roster sort', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockTeam = baseTeam();
    signIn();
  });

  it('renders the roster in jersey order by default (0 first, no number last)', () => {
    const screen = render(<TeamDetailsScreen />);
    expect(renderedOrder(screen)).toEqual(['Zed Zero', 'Amy Five', 'Bob NoNumber']);
    expect(screen.getByLabelText('Sort by Jersey #')).toHaveProp('accessibilityState', {
      selected: true,
    });
  });

  it('reorders by name when the Name pill is tapped and persists the choice', async () => {
    const screen = render(<TeamDetailsScreen />);
    fireEvent.press(screen.getByLabelText('Sort by Name'));

    expect(renderedOrder(screen)).toEqual(['Amy Five', 'Bob NoNumber', 'Zed Zero']);
    await waitFor(async () => {
      expect(await AsyncStorage.getItem(rosterSortStorageKey('coach-1'))).toBe('name');
    });
  });

  it('hydrates a persisted name preference on mount', async () => {
    await AsyncStorage.setItem(rosterSortStorageKey('coach-1'), 'name');
    const screen = render(<TeamDetailsScreen />);

    await waitFor(() => {
      expect(renderedOrder(screen)).toEqual(['Amy Five', 'Bob NoNumber', 'Zed Zero']);
    });
  });

  it('falls back to jersey order when the stored value is garbage', async () => {
    await AsyncStorage.setItem(rosterSortStorageKey('coach-1'), 'ppg');
    const screen = render(<TeamDetailsScreen />);

    expect(renderedOrder(screen)).toEqual(['Zed Zero', 'Amy Five', 'Bob NoNumber']);
  });

  it('hides the sort pills for a single-player roster', () => {
    mockTeam = { ...baseTeam(), members: [makeMember('p-solo', 'Solo Player', 5)] };
    const screen = render(<TeamDetailsScreen />);

    expect(screen.queryByLabelText('Sort by Name')).toBeNull();
    expect(screen.getByText('Solo Player')).toBeTruthy();
  });
});
