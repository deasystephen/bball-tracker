/**
 * Teams, Games and Invitations tabs decide error-vs-content through
 * `utils/query-state.ts#showQueryError` (#888), like the Stats tab (#728): a failed first
 * load shows `ErrorState` with Try Again, a failed background refetch keeps the cached list.
 */

import { render, fireEvent } from '@testing-library/react-native';

import TeamsScreen from '../../app/(tabs)/teams';
import GamesScreen from '../../app/(tabs)/games';
import InvitationsScreen from '../../app/(tabs)/invitations';
import { useAuthStore } from '../../store/auth-store';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';

interface MockQuery {
  data?: unknown;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: jest.Mock;
  isRefetching: boolean;
  fetchNextPage: jest.Mock;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}
let mockTeamsQuery: MockQuery;
let mockGamesQuery: MockQuery;
let mockInvitationsQuery: MockQuery;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTabBarPadding', () => ({ useTabBarPadding: () => 0 }));
jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
// jest.setup mocks the whole api-client; keep the real error-message mapping, which is
// what sends `error_shown`.
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  getApiErrorMessage: jest.requireActual('../../services/api-client').getApiErrorMessage,
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  TEAMS_MAX_LIMIT: 100,
  useInfiniteTeams: () => mockTeamsQuery,
  useTeams: () => ({ data: [], isLoading: false }),
}));
jest.mock('../../hooks/useGames', () => ({
  ...jest.requireActual('../../hooks/useGames'),
  useInfiniteGames: () => mockGamesQuery,
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  usePlayerInvitations: () => mockInvitationsQuery,
  useAcceptInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRejectInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

function query(data: unknown, overrides: Partial<MockQuery> = {}): MockQuery {
  return {
    data,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: jest.fn(),
    isRefetching: false,
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  };
}

const failedFirstLoad = (message: string): MockQuery =>
  query(undefined, { error: new Error(message) });

const TEAM = { id: 'team-1', name: 'Wildcats', season: null, _count: { players: 3 } };
const GAME = {
  id: 'game-1',
  status: 'SCHEDULED',
  opponent: 'Hornets',
  gameDate: new Date(Date.now() + 86400000).toISOString(),
  homeScore: 0,
  awayScore: 0,
  team: { id: 'team-1', name: 'Wildcats' },
};

function errorShownCalls(): unknown[][] {
  return (trackEvent as jest.Mock).mock.calls.filter(([event]) => event === AnalyticsEvents.ERROR_SHOWN);
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({
    user: { id: 'u1', email: 'c@example.test', name: 'Coach', role: 'COACH' },
  } as never);
  mockTeamsQuery = query({ teams: [TEAM] });
  mockGamesQuery = query({ games: [GAME] });
  mockInvitationsQuery = query({ invitations: [], guardianInvitations: [] });
});

describe('Teams tab', () => {
  it('shows ErrorState with Try Again when the first load fails', () => {
    mockTeamsQuery = failedFirstLoad('Network Error');
    const view = render(<TeamsScreen />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText('Network Error')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockTeamsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached list when a background refetch fails', () => {
    mockTeamsQuery = query({ teams: [TEAM] }, { error: new Error('Network Error') });
    const view = render(<TeamsScreen />);

    expect(view.getByText('Wildcats')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it('shows the spinner, not the same error, while Try Again is in flight', () => {
    mockTeamsQuery = { ...failedFirstLoad('Network Error'), isFetching: true };
    const view = render(<TeamsScreen />);

    expect(view.queryByText('Something went wrong')).toBeNull();
  });

  it('reports the failure through getApiErrorMessage once, not on every render', () => {
    mockTeamsQuery = failedFirstLoad('Network Error');
    const view = render(<TeamsScreen />);
    view.rerender(<TeamsScreen />);

    expect(errorShownCalls()).toHaveLength(1);
  });
});

describe('Games tab', () => {
  it('shows ErrorState with Try Again when the first load fails', () => {
    mockGamesQuery = failedFirstLoad('Request failed with status code 500');
    const view = render(<GamesScreen />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText('Request failed with status code 500')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockGamesQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached list when a background refetch fails', () => {
    mockGamesQuery = query({ games: [GAME] }, { error: new Error('Network Error') });
    const view = render(<GamesScreen />);

    expect(view.queryByText('Something went wrong')).toBeNull();
    expect(view.getByText(/Hornets/)).toBeTruthy();
  });

  it('shows the spinner, not the same error, while Try Again is in flight', () => {
    mockGamesQuery = { ...failedFirstLoad('Network Error'), isFetching: true };
    const view = render(<GamesScreen />);

    expect(view.queryByText('Something went wrong')).toBeNull();
  });
});

describe('Invitations tab', () => {
  const CACHED = {
    invitations: [
      {
        id: 'ti1',
        teamId: 't2',
        playerId: 'p1',
        status: 'PENDING',
        teamName: 'Warriors',
        inviterName: 'Steve Kerr',
        expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        team: { id: 't2', name: 'Warriors', season: { id: 's1', name: '2026', league: { id: 'l1', name: 'City League' } } },
      },
    ],
    guardianInvitations: [],
  };

  it('shows ErrorState with Try Again when the first load fails', () => {
    mockInvitationsQuery = failedFirstLoad('Network Error');
    const view = render(<InvitationsScreen />);

    expect(view.getByText('Something went wrong')).toBeTruthy();
    expect(view.getByText('Network Error')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockInvitationsQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached invitations when a background refetch fails', () => {
    mockInvitationsQuery = query(CACHED, { error: new Error('Network Error') });
    const view = render(<InvitationsScreen />);

    expect(view.queryByText('Something went wrong')).toBeNull();
    expect(view.getAllByText(/Warriors/).length).toBeGreaterThan(0);
  });

  it('shows the spinner, not the same error, while Try Again is in flight', () => {
    mockInvitationsQuery = { ...failedFirstLoad('Network Error'), isFetching: true };
    const view = render(<InvitationsScreen />);

    expect(view.queryByText('Something went wrong')).toBeNull();
  });
});
