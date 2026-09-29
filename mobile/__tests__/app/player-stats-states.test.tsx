/**
 * Player stats screen: what it shows when the stats cannot be loaded (#589).
 *
 * A guardian who opened a child's stats was refused by the API, and the error
 * screen offered Try Again and nothing else. The refusal is fixed in the
 * backend; any other failure still lands here, so the screen keeps a way back.
 */

import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';
import { render, fireEvent } from '@testing-library/react-native';

import PlayerStatsScreen from '../../app/players/[id]/stats';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockRefetch = jest.fn();
let mockQuery: { data?: unknown; isLoading: boolean; error: unknown; refetch: jest.Mock };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'child-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../hooks/useStats', () => ({
  ...jest.requireActual('../../hooks/useStats'),
  usePlayerOverallStats: () => mockQuery,
}));

function httpError(status: number, message: string): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const error = new AxiosError(message, 'ERR_BAD_REQUEST', config, undefined, {
    status,
    statusText: '',
    data: { error: message },
    headers: {},
    config,
  });
  // What the api-client's interceptor does with the server's message.
  error.message = message;
  return error;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery = { data: undefined, isLoading: false, error: null, refetch: mockRefetch };
  useAuthStore.setState({
    user: { id: 'gloria', role: 'PARENT', email: 'gloria.james@example.com', name: 'Gloria James' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('PlayerStatsScreen — when the stats cannot be loaded', () => {
  it('shows the reason, Try Again and Go back for a refusal', () => {
    mockQuery.error = httpError(403, "You do not have access to this player's teams");
    const view = render(<PlayerStatsScreen />);

    expect(view.getByText("You do not have access to this player's teams")).toBeTruthy();

    fireEvent.press(view.getByLabelText('Go back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();

    fireEvent.press(view.getByLabelText('Try Again'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('shows a way back for a failure that is not an HTTP answer', () => {
    mockQuery.error = new Error('Network Error');
    const view = render(<PlayerStatsScreen />);

    expect(view.getByText('Network Error')).toBeTruthy();
    expect(view.getByLabelText('Go back')).toBeTruthy();
  });

  it('shows a way back when there is neither data nor an error', () => {
    const view = render(<PlayerStatsScreen />);

    expect(view.getByText('Failed to load stats')).toBeTruthy();
    expect(view.getByLabelText('Go back')).toBeTruthy();
  });

  it('keeps the empty state, not the error, for another player with no team (404)', () => {
    mockQuery.error = httpError(404, 'Player not found or has no team memberships');
    const view = render(<PlayerStatsScreen />);

    expect(view.getByText('No stats for this player')).toBeTruthy();
    expect(view.queryByText('Something went wrong')).toBeNull();

    fireEvent.press(view.getByText('Go back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
