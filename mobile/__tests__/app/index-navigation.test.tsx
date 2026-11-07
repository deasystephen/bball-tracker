/**
 * Root index screen: a failed initial navigation is logged, never silent (#963).
 *
 * The screen retries on the next effect run, so a failure is invisible to the
 * user unless it repeats; `log.warn` leaves the Sentry breadcrumb that
 * explains a stuck "Loading…" screen.
 */

import { render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import Index from '../../app/index';
import { log } from '../../services/log';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

describe('Index initial navigation', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('true');
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null, isAuthenticated: false, isLoading: false });
  });

  afterEach(() => warn.mockRestore());

  it('routes a signed-out, onboarded user to /login without logging', async () => {
    render(<Index />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/login'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a warning when navigation throws', async () => {
    mockRouter.replace.mockImplementationOnce(() => {
      throw new Error('navigator not ready');
    });

    render(<Index />);

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Navigation failed, will retry', { error: expect.any(Error) })
    );
  });
});
