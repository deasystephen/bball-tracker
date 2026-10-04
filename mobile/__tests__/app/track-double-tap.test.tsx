/**
 * Tracker double tap (#730): the player is deselected in the same tick as the
 * first tap, before the POST resolves, so a second tap on a shot or stat
 * button cannot record a duplicate event.
 *
 * Renders the real tracker with the real PlayerRoster, ShotButtons and
 * StatButtons; only the network hooks are mocked. `mutateAsync` returns a
 * promise the test releases by hand, so the second tap always lands while the
 * first create is still in flight.
 */

import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';

import TrackGameScreen from '../../app/games/[id]/track';
import { useAuthStore } from '../../store/auth-store';
import { useGameTrackingStore } from '../../store/game-tracking-store';
import type { Game } from '../../types/game';
import type { TeamStaff } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockMutateAsync = jest.fn();
let mockGame: Game | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'g1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-confetti-cannon', () => () => null);
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useGames', () => ({
  useGame: () => ({ data: mockGame, isLoading: false, error: null, refetch: jest.fn() }),
  useUpdateGame: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../hooks/useGameEvents', () => ({
  useGameEvents: () => ({ data: [], isLoading: false, refetch: jest.fn() }),
  useCreateGameEvent: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  useDeleteGameEvent: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const trackerRole: TeamStaff['role'] = {
  id: 'r-head',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
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
    members: [
      {
        id: 'm1',
        playerId: 'p1',
        jerseyNumber: 7,
        player: { id: 'p1', name: 'Jamie Lee', email: 'jamie@example.test' },
      },
    ],
    season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
    staff: [
      { id: 'ts1', userId: 'coach-1', user: { id: 'coach-1', name: 'Coach', email: 'c@x' }, role: trackerRole },
    ],
  },
};

/** A mutateAsync result the test resolves or rejects by hand. */
function deferred() {
  let resolve!: (value: { event: { id: string } }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ event: { id: string } }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const selectPlayer = () => fireEvent.press(screen.getByLabelText('Jamie Lee, number 7'));

describe('TrackGameScreen double tap (#730)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGame = game;
    useAuthStore.setState({
      user: { id: 'coach-1', role: 'COACH', email: 'x@y.z', name: 'Coach' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    // Unmount first: the screen clears the session on unmount, and a store
    // reset under a mounted screen is an update outside act.
    cleanup();
    const { undoTimerId } = useGameTrackingStore.getState();
    if (undoTimerId) clearTimeout(undoTimerId);
    useGameTrackingStore.getState().clearSession();
  });

  it('records one shot for two taps on the same button and deselects before the POST resolves', async () => {
    const pending = deferred();
    mockMutateAsync.mockReturnValue(pending.promise);
    render(<TrackGameScreen />);

    selectPlayer();
    expect(useGameTrackingStore.getState().selectedPlayerId).toBe('p1');

    fireEvent.press(screen.getByLabelText('2-point shot made'));
    fireEvent.press(screen.getByLabelText('2-point shot made'));

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith({
      gameId: 'g1',
      data: { playerId: 'p1', eventType: 'SHOT', metadata: { made: true, points: 2 } },
    });
    // Deselected while the create is still in flight.
    expect(useGameTrackingStore.getState().selectedPlayerId).toBeNull();
    expect(useGameTrackingStore.getState().localEvents).toHaveLength(1);

    await act(async () => {
      pending.resolve({ event: { id: 'srv-1' } });
    });

    // The undo target is the one event, now confirmed.
    expect(useGameTrackingStore.getState().lastEvent?.serverId).toBe('srv-1');
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('drops a second tap that lands before the disabled buttons re-render', async () => {
    const pending = deferred();
    mockMutateAsync.mockReturnValue(pending.promise);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<TrackGameScreen />);
    selectPlayer();

    // Both taps run inside one act scope, so React does not re-render
    // between them: the second tap reaches an enabled button whose handler
    // closure still holds the selection, the way two touches in one frame do.
    const button = screen.getByLabelText('3-point shot made');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(useGameTrackingStore.getState().localEvents).toHaveLength(1);
    // A consumed selection is a duplicate, not a forgotten selection.
    expect(alertSpy).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ event: { id: 'srv-2' } });
    });
    alertSpy.mockRestore();
  });

  it('records one stat for two taps on the same stat button', async () => {
    const pending = deferred();
    mockMutateAsync.mockReturnValue(pending.promise);
    render(<TrackGameScreen />);
    selectPlayer();

    fireEvent.press(screen.getByLabelText('Record Steal'));
    fireEvent.press(screen.getByLabelText('Record Steal'));

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith({
      gameId: 'g1',
      data: { playerId: 'p1', eventType: 'STEAL', metadata: {} },
    });
    expect(useGameTrackingStore.getState().selectedPlayerId).toBeNull();

    // The same-frame race for stats: select again, then two taps before any
    // re-render. Still only one more create.
    selectPlayer();
    const button = screen.getByLabelText('Record Assist');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockMutateAsync).toHaveBeenLastCalledWith({
      gameId: 'g1',
      data: { playerId: 'p1', eventType: 'ASSIST', metadata: {} },
    });

    await act(async () => {
      pending.resolve({ event: { id: 'srv-3' } });
    });
    // Both creates share the one deferred promise; the newest is the undo target.
    expect(useGameTrackingStore.getState().lastEvent?.eventType).toBe('ASSIST');
    expect(useGameTrackingStore.getState().lastEvent?.serverId).toBe('srv-3');
  });

  it('on a failed create discards the local event, shows the error and gives the selection back', async () => {
    const pending = deferred();
    mockMutateAsync.mockReturnValue(pending.promise);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<TrackGameScreen />);
    selectPlayer();

    fireEvent.press(screen.getByLabelText('2-point shot made'));
    expect(useGameTrackingStore.getState().selectedPlayerId).toBeNull();

    await act(async () => {
      pending.reject(new Error('Network down'));
    });

    expect(useGameTrackingStore.getState().localEvents).toHaveLength(0);
    expect(useGameTrackingStore.getState().lastEvent).toBeNull();
    expect(alertSpy).toHaveBeenCalledWith('Error', 'Network down');
    expect(useGameTrackingStore.getState().selectedPlayerId).toBe('p1');
    alertSpy.mockRestore();
  });

  it('records nothing for a tap with no player selected', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<TrackGameScreen />);

    // Disabled until a player is selected: the press never reaches the handler.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('2-point shot made'));
      fireEvent.press(screen.getByLabelText('Record Steal'));
    });

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(useGameTrackingStore.getState().localEvents).toHaveLength(0);
    alertSpy.mockRestore();
  });
});
