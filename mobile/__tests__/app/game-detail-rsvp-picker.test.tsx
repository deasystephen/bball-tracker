/**
 * Game detail — "Responding for" RSVP picker for guardians (PARENT role,
 * docs/plans/parent-role-spec.md).
 *
 * A guardian of at least one member of the game's team picks who they are
 * responding for; a child's RSVP is sent with `playerId` and the selected
 * state reads the child's row. Non-guardians never see the picker.
 */

import { render, fireEvent } from '@testing-library/react-native';

import GameDetailScreen from '../../app/games/[id]/index';
import { useAuthStore } from '../../store/auth-store';
import type { Game, GameRsvp } from '../../types/game';
import type { GuardianOfEntry } from '../../../shared/types';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockSubmitRsvp = jest.fn();
let mockGame: Game | undefined;
let mockRsvps: GameRsvp[] = [];

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
  useGameRsvps: () => ({ data: { rsvps: mockRsvps, summary: { yes: 0, no: 0, maybe: 0, noResponse: 0 } } }),
  useSubmitRsvp: () => ({ mutate: mockSubmitRsvp }),
}));
jest.mock('../../hooks/useStats', () => ({
  useBoxScore: () => ({ data: undefined, isLoading: false }),
}));

const member = (playerId: string, name: string) => ({
  id: `m-${playerId}`,
  playerId,
  player: { id: playerId, name, email: '' },
});

const baseGame: Game = {
  id: 'g1',
  teamId: 't1',
  opponent: 'Lakers',
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
    staff: [],
    members: [member('steph', 'Steph Curry'), member('klay', 'Klay Thompson')],
  },
};

const signIn = (id: string, guardianOf?: GuardianOfEntry[]) => {
  useAuthStore.setState({
    user: { id, role: 'PLAYER', email: 'x@y.z', name: 'X', guardianOf } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

const stephLink: GuardianOfEntry = { childId: 'steph', childName: 'Steph Curry', relationship: 'FATHER', isPrimary: true };
const sethLink: GuardianOfEntry = { childId: 'seth', childName: 'Seth Curry', relationship: 'FATHER', isPrimary: true };

describe('GameDetailScreen RSVP picker (guardians)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGame = baseGame;
    mockRsvps = [];
  });

  it('rostered player without children: no picker, RSVP sent for self', () => {
    signIn('klay');
    const { queryByTestId, getByText } = render(<GameDetailScreen />);
    expect(queryByTestId('rsvp-responding-for')).toBeNull();
    fireEvent.press(getByText('Going'));
    expect(mockSubmitRsvp).toHaveBeenCalledWith({ gameId: 'g1', status: 'YES', playerId: undefined });
  });

  it('guardian not on the roster: picker lists only the child (on this team) and defaults to them', () => {
    signIn('dell', [stephLink, sethLink]);
    const { getByTestId, queryByLabelText, getByLabelText, getByText } = render(<GameDetailScreen />);
    expect(getByTestId('rsvp-responding-for')).toBeTruthy();
    expect(getByLabelText('Respond for Steph Curry')).toBeTruthy();
    // Seth is not on the Warriors roster; Dell is not rostered either.
    expect(queryByLabelText('Respond for Seth Curry')).toBeNull();
    expect(queryByLabelText('Respond for Me')).toBeNull();

    fireEvent.press(getByText('Going'));
    expect(mockSubmitRsvp).toHaveBeenCalledWith({ gameId: 'g1', status: 'YES', playerId: 'steph' });
  });

  it('guardian who is also rostered: "Me" first, child selectable', () => {
    mockGame = {
      ...baseGame,
      team: { ...baseGame.team!, members: [...baseGame.team!.members!, member('dell', 'Dell Curry')] },
    };
    signIn('dell', [stephLink]);
    const { getByLabelText, getByText } = render(<GameDetailScreen />);
    expect(getByLabelText('Respond for Me')).toBeTruthy();

    fireEvent.press(getByText('Going'));
    expect(mockSubmitRsvp).toHaveBeenLastCalledWith({ gameId: 'g1', status: 'YES', playerId: undefined });

    fireEvent.press(getByLabelText('Respond for Steph Curry'));
    fireEvent.press(getByText('Maybe'));
    expect(mockSubmitRsvp).toHaveBeenLastCalledWith({ gameId: 'g1', status: 'MAYBE', playerId: 'steph' });
  });

  it("selected state reflects the child's existing RSVP row", () => {
    mockRsvps = [
      {
        id: 'r1',
        gameId: 'g1',
        userId: 'steph',
        status: 'NO',
        createdAt: '',
        updatedAt: '',
        user: { id: 'steph', name: 'Steph Curry' },
      },
    ];
    signIn('dell', [stephLink]);
    const { getByText } = render(<GameDetailScreen />);
    const notGoing = getByText('Not Going');
    expect(notGoing.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: '#FFFFFF' })]));
  });
});
