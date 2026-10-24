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

import Login, { BROWSER_DISMISS_GRACE_MS } from '../../app/login';
import { apiClient } from '../../services/api-client';
import { trackEvent } from '../../services/analytics';

const mockLinkingState: { urlHandler: ((event: { url: string }) => void) | null; remove: jest.Mock } = {
  urlHandler: null,
  remove: jest.fn(),
};
jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string, options?: { scheme?: string }) => `${options?.scheme ?? 'exp'}://${path}`),
  canOpenURL: jest.fn(() => Promise.resolve(true)),
  openURL: jest.fn(() => Promise.resolve()),
  addEventListener: jest.fn((_type: string, handler: (event: { url: string }) => void) => {
    mockLinkingState.urlHandler = handler;
    return { remove: mockLinkingState.remove };
  }),
}));

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));
const mockedTrack = trackEvent as jest.Mock;
const signInEvents = () =>
  mockedTrack.mock.calls.filter(([event]) => event === 'sign_in_started' || event === 'sign_in_failed');

jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));

jest.mock('../../utils/pkce', () => ({
  beginPkceLogin: jest.fn(() => Promise.resolve({ state: 'state-123', codeChallenge: 'challenge-abc' })),
}));

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
    // The redirect scheme is passed explicitly (#504): the manifest scheme is
    // the OTA payload, not what the binary registers.
    expect(Linking.createURL).toHaveBeenCalledWith('auth/callback', { scheme: 'hooplings' });
    // PKCE + state (audit #5) travel with the authorization request.
    expect(mockedGet).toHaveBeenCalledWith('/auth/login', {
      params: {
        format: 'json',
        redirect_uri: 'hooplings://auth/callback',
        state: 'state-123',
        code_challenge: 'challenge-abc',
      },
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
    expect(mockLinkingState.remove).toHaveBeenCalled();
  });

  describe('sign-in funnel events (#967)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    async function startSignIn() {
      const utils = render(<Login />);
      fireEvent.press(utils.getByLabelText('Sign in'));
      await waitFor(() => expect(Linking.openURL).toHaveBeenCalled());
      return utils;
    }

    it('fires sign_in_started once the PKCE sign-in has begun', async () => {
      await startSignIn();
      expect(signInEvents()).toEqual([['sign_in_started']]);
    });

    it('fires sign_in_failed { stage: initiate } with the status when the authorization URL fails', async () => {
      mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 }, message: 'busy' });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { getByLabelText } = render(<Login />);

      fireEvent.press(getByLabelText('Sign in'));

      await waitFor(() => expect(getByLabelText('Sign in')).toBeTruthy());
      expect(signInEvents()).toEqual([['sign_in_started'], ['sign_in_failed', { stage: 'initiate', status: 503 }]]);
      errorSpy.mockRestore();
    });

    it('fires sign_in_failed { stage: initiate } without a status when the browser cannot open', async () => {
      (Linking.canOpenURL as jest.Mock).mockResolvedValueOnce(false);
      const { getByLabelText } = render(<Login />);

      fireEvent.press(getByLabelText('Sign in'));

      await waitFor(() => expect(getByLabelText('Sign in')).toBeTruthy());
      expect(signInEvents()).toEqual([['sign_in_started'], ['sign_in_failed', { stage: 'initiate' }]]);
    });

    it('fires sign_in_failed { stage: browser_dismissed } when the app returns with no callback', async () => {
      await startSignIn();
      jest.useFakeTimers();

      act(() => {
        appStateHandler?.('background');
        appStateHandler?.('active');
      });
      expect(signInEvents()).toEqual([['sign_in_started']]);

      act(() => {
        jest.advanceTimersByTime(BROWSER_DISMISS_GRACE_MS);
      });
      expect(signInEvents()).toEqual([['sign_in_started'], ['sign_in_failed', { stage: 'browser_dismissed' }]]);
    });

    it('does not count a return that brought the callback deep link as a dismissal', async () => {
      await startSignIn();
      jest.useFakeTimers();

      act(() => {
        appStateHandler?.('active');
        mockLinkingState.urlHandler?.({ url: 'hooplings://auth/callback?code=c&state=s' });
        jest.advanceTimersByTime(BROWSER_DISMISS_GRACE_MS);
      });

      expect(signInEvents()).toEqual([['sign_in_started']]);
    });

    it('reports nothing if the screen unmounts within the grace period (sign-in completed)', async () => {
      const { unmount } = await startSignIn();
      jest.useFakeTimers();

      act(() => {
        appStateHandler?.('active');
      });
      unmount();
      act(() => {
        jest.advanceTimersByTime(BROWSER_DISMISS_GRACE_MS);
      });

      expect(signInEvents()).toEqual([['sign_in_started']]);
    });
  });
});
