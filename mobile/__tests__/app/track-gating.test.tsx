/**
 * Tracker screen (/games/:id/track) — deep-linkable, so it guards itself:
 * users without `canTrackStats` get a toast and are bounced to the game
 * detail instead of a tracker whose every event POST would 403.
 */

import { render, waitFor } from '@testing-library/react-native';

import TrackGameScreen from '../../app/games/[id]/track';
import { useAuthStore } from '../../store/auth-store';
import type { Game } from '../../types/game';
import type { TeamStaff } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
let mockGame: Game | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'g1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useGames', () => ({
  useGame: () => ({ data: mockGame, isLoading: false, error: null, refetch: jest.fn() }),
  useUpdateGame: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../hooks/useGameEvents', () => ({
  useGameEvents: () => ({ data: [], isLoading: false, refetch: jest.fn() }),
  useCreateGameEvent: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteGameEvent: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../components/game', () => {
  const { Text } = jest.requireActual('react-native');
  const stub = (label: string) => {
    const Stub = () => <Text>{label}</Text>;
    Stub.displayName = label;
    return Stub;
  };
  return {
    ScoreDisplay: stub('ScoreDisplay'),
    PlayerRoster: stub('PlayerRoster'),
    ShotButtons: stub('ShotButtons'),
    StatButtons: stub('StatButtons'),
    EventTimeline: stub('EventTimeline'),
    UndoBanner: stub('UndoBanner'),
    OpponentScoreButtons: stub('OpponentScoreButtons'),
  };
});

const trackerRole: TeamStaff['role'] = {
  id: 'r-asst',
  name: 'Assistant Coach',
  type: 'ASSISTANT_COACH',
  canManageTeam: false,
  canManageRoster: false,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: false,
};

const game: Game = {
  id: 'g1',
  teamId: 't1',
  opponent: 'Rivals',
  date: '2026-08-30T18:00:00Z',
  status: 'IN_PROGRESS',
  homeScore: 0,
  awayScore: 0,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  team: {
    id: 't1',
    name: 'Warriors',
    members: [],
    season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
    staff: [
      { id: 'ts1', userId: 'asst-1', user: { id: 'asst-1', name: 'Asst', email: 'a@x' }, role: trackerRole },
    ],
  },
};

const signIn = (id: string, role: 'PLAYER' | 'COACH' | 'ADMIN') => {
  useAuthStore.setState({
    user: { id, role, email: 'x@y.z', name: 'X' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('TrackGameScreen permission guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGame = game;
  });

  it('bounces a player to the game detail with a toast and never renders the tracker', async () => {
    signIn('player-1', 'PLAYER');
    const { queryByText } = render(<TrackGameScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/games/g1'));
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/permission/i), 'error');
    expect(queryByText('StatButtons')).toBeNull();
  });

  it('renders the tracker for staff with canTrackStats', async () => {
    signIn('asst-1', 'COACH');
    const { findByText } = render(<TrackGameScreen />);

    expect(await findByText('StatButtons')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('renders the tracker for a system ADMIN with no staff row', async () => {
    signIn('admin-1', 'ADMIN');
    const { findByText } = render(<TrackGameScreen />);
    expect(await findByText('StatButtons')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
