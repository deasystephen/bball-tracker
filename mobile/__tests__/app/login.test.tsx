/**
 * Login screen — spinner lifecycle around the system browser (audit #33).
 *
 * `Linking.openURL` resolves as soon as the browser opens, so the screen
 * cannot know whether the user finished sign-in (deep link → /auth/callback)
 * or backed out. It therefore clears the spinner when the app returns to
 * the foreground while a browser sign-in is pending.
 */

import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { AppState } from 'react-native';
import * as Linking from 'expo-linking';

import Login from '../../app/login';
import { apiClient } from '../../services/api-client';

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `bball-tracker://${path}`),
  canOpenURL: jest.fn(() => Promise.resolve(true)),
  openURL: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));

const mockedGet = apiClient.get as jest.Mock;

type AppStateHandler = (state: string) => void;

describe('Login screen', () => {
  let appStateHandler: AppStateHandler | null;
  let removeSubscription: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    appStateHandler = null;
    removeSubscription = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      appStateHandler = handler as AppStateHandler;
      return { remove: removeSubscription };
    });
    mockedGet.mockResolvedValue({ data: { url: 'https://auth.example.test/authorize' } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens the browser and shows the spinner while sign-in is pending', async () => {
    const { getByLabelText, queryByLabelText } = render(<Login />);

    fireEvent.press(getByLabelText('Sign in'));

    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://auth.example.test/authorize'));
    expect(mockedGet).toHaveBeenCalledWith('/auth/login', {
      params: { format: 'json', redirect_uri: 'bball-tracker://auth/callback' },
    });
    // Button is replaced by the spinner.
    expect(queryByLabelText('Sign in')).toBeNull();
  });

  it('clears the spinner when the app returns to the foreground without a callback', async () => {
    const { getByLabelText, queryByLabelText } = render(<Login />);

    fireEvent.press(getByLabelText('Sign in'));
    await waitFor(() => expect(queryByLabelText('Sign in')).toBeNull());

    act(() => {
      appStateHandler?.('background');
      appStateHandler?.('active');
    });

    expect(getByLabelText('Sign in')).toBeTruthy();
  });

  it('ignores foreground transitions when no browser sign-in is pending', () => {
    const { getByLabelText } = render(<Login />);

    act(() => {
      appStateHandler?.('active');
    });

    expect(getByLabelText('Sign in')).toBeTruthy();
  });

  it('clears the spinner immediately when the authorization URL cannot be fetched', async () => {
    mockedGet.mockRejectedValueOnce(new Error('network'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getByLabelText } = render(<Login />);

    fireEvent.press(getByLabelText('Sign in'));

    await waitFor(() => expect(getByLabelText('Sign in')).toBeTruthy());
    expect(Linking.openURL).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('removes the AppState subscription on unmount', () => {
    const { unmount } = render(<Login />);
    unmount();
    expect(removeSubscription).toHaveBeenCalled();
  });
});
