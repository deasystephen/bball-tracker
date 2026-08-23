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

  it('shows the WorkOS error without touching pending state or the backend', async () => {
    mockParams.error = 'access_denied';

    const { findByText } = render(<AuthCallbackScreen />);

    expect(await findByText('access_denied')).toBeTruthy();
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
});
