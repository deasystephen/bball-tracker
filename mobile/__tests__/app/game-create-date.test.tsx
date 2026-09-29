/**
 * Choosing the date and time on the create-game screen (#576).
 *
 * On build #33 the picker opened under the keyboard and closed on the first
 * wheel movement, so a game could only be created for "now". These tests
 * drive the screen the way a coach does: open, move the wheels, confirm.
 */

import React from 'react';
import { Keyboard } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import CreateGameScreen from '../../app/games/create';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockCreateGame = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useAccessGuard', () => ({ useAccessGuard: () => true }));
jest.mock('../../hooks/useGames', () => ({
  ...jest.requireActual('../../hooks/useGames'),
  useCreateGame: () => mockCreateGame,
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeams: () => ({
    data: [
      {
        id: 'team-1',
        name: 'Lakers',
        seasonId: 'se-1',
        staff: [{ userId: 'coach-1', role: { canManageTeam: true } }],
        season: { id: 'se-1', name: '2026', league: { id: 'lg-1', name: 'Downtown' } },
      },
    ],
    isLoading: false,
  }),
}));
jest.mock('@react-native-community/datetimepicker', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => mockReact.createElement(View, props),
  };
});

// Local time on purpose: the screen formats and combines in the device's zone.
const NOW = new Date(2026, 8, 28, 21, 43, 0);

const moveWheels = (view: ReturnType<typeof render>, to: Date) =>
  fireEvent(view.getByTestId('date-time-picker'), 'onValueChange', { nativeEvent: {} }, to);

beforeEach(() => {
  jest.clearAllMocks();
  // Only the clock is pinned. Timers stay real: the test library waits on them.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'hrtime',
      'performance',
    ],
  });
  mockCreateGame.mutateAsync.mockResolvedValue({ id: 'game-1' });
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'coach@example.com', name: 'Coach' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CreateGameScreen — date and time', () => {
  it('shows today and now, with no picker on screen', () => {
    const view = render(<CreateGameScreen />);

    expect(view.getByLabelText('Game date: Monday, September 28, 2026')).toBeTruthy();
    expect(view.getByLabelText(/^Game time: 9:43\sPM$/)).toBeTruthy();
    expect(view.queryByTestId('date-time-picker')).toBeNull();
  });

  it('puts the keyboard away before it opens the picker', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    const view = render(<CreateGameScreen />);

    fireEvent.press(view.getByTestId('game-date-button'));

    expect(dismiss).toHaveBeenCalled();
    expect(view.getByText('Game date')).toBeTruthy();
    expect(view.getByTestId('date-time-picker').props.mode).toBe('date');
  });

  it('changes the date only on Done, and keeps the time', () => {
    const view = render(<CreateGameScreen />);

    fireEvent.press(view.getByTestId('game-date-button'));
    moveWheels(view, new Date(2026, 10, 14, 21, 43, 0));

    // Still open, still the old date on the row behind it.
    expect(view.getByLabelText('Done')).toBeTruthy();
    expect(view.getByLabelText('Game date: Monday, September 28, 2026')).toBeTruthy();

    fireEvent.press(view.getByLabelText('Done'));

    expect(view.queryByTestId('date-time-picker')).toBeNull();
    expect(view.getByLabelText('Game date: Saturday, November 14, 2026')).toBeTruthy();
    expect(view.getByLabelText(/^Game time: 9:43\sPM$/)).toBeTruthy();
  });

  it('leaves the date alone on Cancel', () => {
    const view = render(<CreateGameScreen />);

    fireEvent.press(view.getByTestId('game-date-button'));
    moveWheels(view, new Date(2026, 10, 14, 21, 43, 0));
    // By id: the form behind the sheet has a Cancel button of its own.
    fireEvent.press(view.getByTestId('date-time-picker-cancel'));

    expect(view.queryByTestId('date-time-picker')).toBeNull();
    expect(view.getByLabelText('Game date: Monday, September 28, 2026')).toBeTruthy();
  });

  it('sends the chosen date and time when the game is created', async () => {
    const view = render(<CreateGameScreen />);

    fireEvent.press(view.getByTestId('game-date-button'));
    moveWheels(view, new Date(2026, 10, 14, 21, 43, 0));
    fireEvent.press(view.getByLabelText('Done'));

    fireEvent.press(view.getByTestId('game-time-button'));
    expect(view.getByText('Game time')).toBeTruthy();
    expect(view.getByTestId('date-time-picker').props.mode).toBe('time');
    moveWheels(view, new Date(2026, 10, 14, 10, 15, 0));
    fireEvent.press(view.getByLabelText('Done'));

    fireEvent.changeText(view.getByTestId('opponent-name-input'), 'Test Rival');
    fireEvent.press(view.getByText('Lakers'));
    fireEvent.press(view.getByText('Create Game'));

    await waitFor(() => expect(mockCreateGame.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateGame.mutateAsync).toHaveBeenCalledWith({
      teamId: 'team-1',
      opponent: 'Test Rival',
      date: new Date(2026, 10, 14, 10, 15, 0).toISOString(),
    });
  });
});
