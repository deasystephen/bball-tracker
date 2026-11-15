/**
 * Home — the pending-invitations bell counts staff invitations (#460) next
 * to team invitations, so an invitee who opens the app without the emailed
 * link still sees there is something to accept. Renders the real i18n
 * instance.
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
let mockInvitations: unknown = { invitations: [] };

jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useInfiniteTeams: () => query({ teams: [], total: 0 }),
}));
jest.mock('../../hooks/useGames', () => ({
  useLiveGames: () => query([]),
  useGames: () => query([]),
  useGamesPage: () => query({ games: [], total: 0 }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  useInvitations: () => query(mockInvitations),
}));

describe('Home invitations bell', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', role: 'COACH', email: 'new.coach@example.com', name: 'Nia New' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  it('shows the bell with the count when the only pending invitation is a staff one', () => {
    mockInvitations = {
      invitations: [],
      staffInvitations: [
        {
          kind: 'staff',
          id: 'si1',
          status: 'PENDING',
          teamName: 'Hornets',
          roleType: 'ASSISTANT_COACH',
          inviterName: 'Casey Head',
          inviterDeletedAt: null,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      ],
    };
    render(<Home />);
    expect(screen.getByRole('button', { name: '1 pending invitation' })).toBeTruthy();
  });

  it('shows no bell when nothing is pending', () => {
    mockInvitations = { invitations: [] };
    render(<Home />);
    expect(screen.queryByRole('button', { name: /pending invitation/ })).toBeNull();
  });
});
