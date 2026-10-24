/**
 * OAuth callback screen — state validation + PKCE verifier (audit #5).
 *
 * The custom-scheme redirect can be delivered by any app, so the screen must
 * refuse to exchange a code whose `state` does not match the sign-in this
 * device started, and must send the stored `code_verifier` with a valid one.
 */

import { render, waitFor } from '@testing-library/react-native';

import AuthCallbackScreen from '../../app/auth/callback';
import { apiClient } from '../../services/api-client';
import { consumePendingLogin } from '../../utils/pkce';
import { useAuthStore } from '../../store/auth-store';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';
import { log } from '../../services/log';

const mockParams: { code?: string; state?: string; error?: string } = {};
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../../utils/pkce', () => ({
  consumePendingLogin: jest.fn(),
}));

jest.mock('../../utils/role-onboarding', () => ({
  postLoginRoute: jest.fn(() => Promise.resolve('/(tabs)')),
}));

jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));

jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  setUserProperties: jest.fn(),
  appVersion: () => '1.5.0',
  AnalyticsEvents: { USER_LOGGED_IN: 'user_logged_in', USER_LOGGED_OUT: 'user_logged_out' },
}));

const mockedGet = apiClient.get as jest.Mock;
const mockedConsume = consumePendingLogin as jest.Mock;

const user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'PLAYER' };

describe('AuthCallbackScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete mockParams.code;
    delete mockParams.state;
    delete mockParams.error;
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null, isAuthenticated: false, isLoading: false });
  });

  it('sends code + state + code_verifier and signs the user in when the state matches', async () => {
    mockParams.code = 'code-1';
    mockParams.state = 'state-1';
    mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
    mockedGet.mockResolvedValue({ data: { accessToken: 'at', refreshToken: 'rt', user } });

    render(<AuthCallbackScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)'));
    expect(mockedConsume).toHaveBeenCalledWith('state-1');
    expect(mockedGet).toHaveBeenCalledWith('/auth/callback', {
      params: { code: 'code-1', state: 'state-1', code_verifier: 'verifier-1' },
    });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'at', refreshToken: 'rt', isAuthenticated: true });
  });

  it.each([
    { claimedInvite: true, wasManaged: true },
    { claimedInvite: false, wasManaged: false },
  ])('fires user_logged_in with the callback outcome flags %o (#790)', async ({ claimedInvite, wasManaged }) => {
    mockParams.code = 'code-1';
    mockParams.state = 'state-1';
    mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
    mockedGet.mockResolvedValue({
      data: { accessToken: 'at', refreshToken: 'rt', user, claimedInvite, wasManaged },
    });

    render(<AuthCallbackScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)'));
    const call = (trackEvent as jest.Mock).mock.calls.find(([event]) => event === AnalyticsEvents.USER_LOGGED_IN);
    expect(call?.[1]).toStrictEqual({ claimed_invite: claimedInvite, was_managed: wasManaged });
  });

  it('fires user_logged_in without the flags when the API does not send them', async () => {
    mockParams.code = 'code-1';
    mockParams.state = 'state-1';
    mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
    mockedGet.mockResolvedValue({ data: { accessToken: 'at', refreshToken: 'rt', user } });

    render(<AuthCallbackScreen />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)'));
    // Strict: toHaveBeenCalledWith would accept { claimed_invite: undefined } as {}
    const call = (trackEvent as jest.Mock).mock.calls.find(([event]) => event === AnalyticsEvents.USER_LOGGED_IN);
    expect(call?.[1]).toStrictEqual({});
  });

  it('refuses to exchange the code when the state does not match a sign-in from this device', async () => {
    mockParams.code = 'attacker-code';
    mockParams.state = 'foreign-state';
    mockedConsume.mockResolvedValue(null);

    const { findByText } = render(<AuthCallbackScreen />);

    expect(await findByText('Sign In Failed')).toBeTruthy();
    expect(await findByText(/did not come from a sign-in started on this device/)).toBeTruthy();
    expect(mockedGet).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('refuses a deep link that carries a code but no state', async () => {
    mockParams.code = 'code-no-state';
    mockedConsume.mockResolvedValue(null);

    const { findByText } = render(<AuthCallbackScreen />);

    expect(await findByText('Sign In Failed')).toBeTruthy();
    expect(mockedConsume).toHaveBeenCalledWith(undefined);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('maps a known OAuth error to our copy without touching pending state or the backend', async () => {
    mockParams.error = 'access_denied';

    const { findByText, queryByText } = render(<AuthCallbackScreen />);

    expect(await findByText('Sign-in was cancelled. You can try again whenever you like.')).toBeTruthy();
    expect(queryByText('access_denied')).toBeNull();
    expect(mockedConsume).not.toHaveBeenCalled();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('never renders an unknown error param verbatim (attacker-controllable deep link, audit #74)', async () => {
    mockParams.error = 'Your account was suspended, call 555-0100';

    const { findByText, queryByText } = render(<AuthCallbackScreen />);

    expect(await findByText('Sign-in did not complete. Please try signing in again.')).toBeTruthy();
    expect(queryByText(/555-0100/)).toBeNull();
    expect(mockedConsume).not.toHaveBeenCalled();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('surfaces a failed exchange (e.g. WorkOS rejected the verifier) as a retryable error', async () => {
    mockParams.code = 'code-1';
    mockParams.state = 'state-1';
    mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
    mockedGet.mockRejectedValue(new Error('500'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const { findByText } = render(<AuthCallbackScreen />);

    expect(await findByText('Failed to complete sign in. Please try again.')).toBeTruthy();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    errorSpy.mockRestore();
  });

  describe('a refused callback is logged, enums only (#963)', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    const signInWarnings = () => warn.mock.calls.filter(([message]) => message === 'Sign-in failed');

    it('logs a known OAuth error by its code', async () => {
      mockParams.error = 'access_denied';
      const { findByText } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');
      expect(signInWarnings()).toEqual([['Sign-in failed', { stage: 'oauth_error', oauth_error: 'access_denied' }]]);
    });

    it('logs an unknown OAuth error as "other", never the raw param', async () => {
      mockParams.error = 'Your account was suspended, call 555-0100';
      const { findByText } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');
      expect(signInWarnings()).toEqual([['Sign-in failed', { stage: 'oauth_error', oauth_error: 'other' }]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('555-0100');
    });

    it('logs a callback with no code', async () => {
      const { findByText } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');
      expect(signInWarnings()).toEqual([['Sign-in failed', { stage: 'missing_code' }]]);
    });

    it('logs a state that does not match a sign-in from this device', async () => {
      mockParams.code = 'attacker-code';
      mockParams.state = 'foreign-state';
      mockedConsume.mockResolvedValue(null);
      const { findByText } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');
      expect(signInWarnings()).toEqual([['Sign-in failed', { stage: 'state_mismatch' }]]);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/attacker-code|foreign-state/);
    });

    it('logs a failure once however often the screen re-renders, and a new one when the params change', async () => {
      mockParams.error = 'server_error';
      const { findByText, rerender } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');
      rerender(<AuthCallbackScreen />);
      rerender(<AuthCallbackScreen />);
      expect(signInWarnings()).toHaveLength(1);

      // A second refused deep link into the same mounted screen.
      mockParams.error = 'access_denied';
      rerender(<AuthCallbackScreen />);
      await waitFor(() => expect(signInWarnings()).toHaveLength(2));
      expect(signInWarnings()[1]).toEqual(['Sign-in failed', { stage: 'oauth_error', oauth_error: 'access_denied' }]);
    });

    it('logs a failed exchange with the HTTP status', async () => {
      mockParams.code = 'code-1';
      mockParams.state = 'state-1';
      mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
      mockedGet.mockRejectedValue({ isAxiosError: true, response: { status: 409 }, message: 'conflict' });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const { findByText } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');

      expect(signInWarnings()).toEqual([['Sign-in failed', { stage: 'exchange', status: 409 }]]);
      errorSpy.mockRestore();
    });

    it('logs a failed exchange with no response without a status', async () => {
      mockParams.code = 'code-1';
      mockParams.state = 'state-1';
      mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
      mockedGet.mockRejectedValue(new Error('Network Error'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const { findByText } = render(<AuthCallbackScreen />);
      await findByText('Sign In Failed');

      expect(signInWarnings()).toEqual([['Sign-in failed', { stage: 'exchange' }]]);
      errorSpy.mockRestore();
    });

    it('logs nothing for a successful sign-in', async () => {
      mockParams.code = 'code-1';
      mockParams.state = 'state-1';
      mockedConsume.mockResolvedValue({ state: 'state-1', verifier: 'verifier-1', createdAt: Date.now() });
      mockedGet.mockResolvedValue({ data: { accessToken: 'at', refreshToken: 'rt', user } });
      render(<AuthCallbackScreen />);
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)'));
      expect(signInWarnings()).toEqual([]);
    });
  });
});
