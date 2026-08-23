/**
 * Game detail screen — lifecycle controls are gated on the user's team
 * permissions, not just the game status (role matrix M12–M18).
 *
 * Players see Watch Live / RSVP / box score only; coaches get Start / End /
 * Delete / Continue Tracking.
 */

import { render } from '@testing-library/react-native';

import GameDetailScreen from '../../app/games/[id]/index';
import { useAuthStore } from '../../store/auth-store';
import type { Game } from '../../types/game';
import type { TeamStaff } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockGame: Game | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'g1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useGames', () => ({
  useGame: () => ({ data: mockGame, isLoading: false, error: null, refetch: jest.fn() }),
  useUpdateGame: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteGame: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useGameRsvps: () => ({ data: undefined }),
  useSubmitRsvp: () => ({ mutate: jest.fn() }),
}));
jest.mock('../../hooks/useStats', () => ({
  useBoxScore: () => ({ data: undefined, isLoading: false }),
}));

const coachRole: TeamStaff['role'] = {
  id: 'r-head',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

const baseGame: Game = {
  id: 'g1',
  teamId: 't1',
  opponent: 'Rivals',
  date: '2026-08-30T18:00:00Z',
  status: 'SCHEDULED',
  homeScore: 0,
  awayScore: 0,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  team: {
    id: 't1',
    name: 'Warriors',
    season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
    staff: [
      { id: 'ts1', userId: 'coach-1', user: { id: 'coach-1', name: 'Coach', email: 'c@x' }, role: coachRole },
    ],
  },
};

const signIn = (user: { id: string; role: 'PLAYER' | 'COACH' | 'ADMIN'; leagueAdminOf?: string[] }) => {
  useAuthStore.setState({
    user: { ...user, email: 'x@y.z', name: 'X' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('GameDetailScreen permission gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('SCHEDULED game', () => {
    beforeEach(() => {
      mockGame = { ...baseGame, status: 'SCHEDULED' };
    });

    it('player (team member, not staff): RSVP only, no Start / Delete', () => {
      signIn({ id: 'player-1', role: 'PLAYER' });
      const { queryByText, queryByLabelText, getByText } = render(<GameDetailScreen />);
      expect(getByText('Going')).toBeTruthy();
      expect(queryByText('Start Game')).toBeNull();
      expect(queryByLabelText('Delete game')).toBeNull();
    });

    it('head coach: Start and Delete available', () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      const { getByText, getByLabelText } = render(<GameDetailScreen />);
      expect(getByText('Start Game')).toBeTruthy();
      expect(getByLabelText('Delete game')).toBeTruthy();
    });

    it('league admin of the team league: treated like a coach', () => {
      signIn({ id: 'la-1', role: 'PLAYER', leagueAdminOf: ['league-1'] });
      const { getByText } = render(<GameDetailScreen />);
      expect(getByText('Start Game')).toBeTruthy();
    });

    it('system ADMIN with no staff row: full controls', () => {
      signIn({ id: 'admin-1', role: 'ADMIN' });
      const { getByText } = render(<GameDetailScreen />);
      expect(getByText('Start Game')).toBeTruthy();
    });
  });

  describe('IN_PROGRESS game', () => {
    beforeEach(() => {
      mockGame = { ...baseGame, status: 'IN_PROGRESS' };
    });

    it('player: Watch Live only', () => {
      signIn({ id: 'player-1', role: 'PLAYER' });
      const { getByText, queryByText } = render(<GameDetailScreen />);
      expect(getByText('Watch Live')).toBeTruthy();
      expect(queryByText('Continue Tracking')).toBeNull();
      expect(queryByText('End Game')).toBeNull();
    });

    it('coach: Watch Live, Continue Tracking and End Game', () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      const { getByText } = render(<GameDetailScreen />);
      expect(getByText('Watch Live')).toBeTruthy();
      expect(getByText('Continue Tracking')).toBeTruthy();
      expect(getByText('End Game')).toBeTruthy();
    });

    it('team manager without canTrackStats: End Game shown, Continue Tracking hidden', () => {
      mockGame = {
        ...baseGame,
        status: 'IN_PROGRESS',
        team: {
          ...baseGame.team!,
          staff: [
            {
              id: 'ts2',
              userId: 'mgr-1',
              user: { id: 'mgr-1', name: 'Mgr', email: 'm@x' },
              role: { ...coachRole, id: 'r-mgr', type: 'TEAM_MANAGER', canTrackStats: false },
            },
          ],
        },
      };
      signIn({ id: 'mgr-1', role: 'COACH' });
      const { getByText, queryByText } = render(<GameDetailScreen />);
      expect(getByText('End Game')).toBeTruthy();
      expect(queryByText('Continue Tracking')).toBeNull();
    });
  });
});
