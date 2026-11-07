/**
 * The age screen (#981): neutral month/year entry, a confirmation step, and
 * the two outcomes. Old enough: `POST /auth/age-confirmation` succeeds, the
 * store says confirmed, the held-back sign-in analytics fire, and the usual
 * post-login route follows. Under the minimum: the screen explains and Done
 * ends the session with no analytics event.
 *
 * Renders with the real i18n instance; the API is a mocked api-client.
 */
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import AgeConfirmationScreen from '../../app/onboarding/age';
import { useAuthStore } from '../../store/auth-store';
import { setSessionHooks } from '../../store/session-hooks';
import { createQueryWrapper } from '../utils/queryWrapper';
import { identifyUser, trackEvent } from '../../services/analytics';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) };
const mockPost = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/onboarding/age',
}));
jest.mock('../../services/api-client', () => ({ apiClient: { post: (...a: unknown[]) => mockPost(...a) } }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../services/analytics', () => ({
  trackEvent: jest.fn(),
  identifyUser: jest.fn(),
  resetUser: jest.fn(),
  setUserProperties: jest.fn(),
  appVersion: () => 'test',
  AnalyticsEvents: {
    USER_LOGGED_IN: 'user_logged_in',
    USER_LOGGED_OUT: 'user_logged_out',
    AGE_CONFIRMED: 'age_confirmed',
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/** A brand-new PLAYER sign-up (the role step would follow). */
const newcomer = {
  id: 'u-new',
  email: 'newcomer@example.com',
  name: 'Newcomer',
  role: 'PLAYER' as const,
  ageConfirmed: false,
};

/** An axios-shaped 403 the api-client would have normalised. */
function refusal(): Error & { isAxiosError: boolean; response: { status: number }; apiError: { code: string; status: number } } {
  return Object.assign(new Error('Hooplings accounts are for ages 13 and up'), {
    isAxiosError: true,
    response: { status: 403, data: { code: 'under_minimum_age' } },
    apiError: { code: 'under_minimum_age', status: 403 },
  });
}

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(
    <Wrapper>
      <AgeConfirmationScreen />
    </Wrapper>
  );
}

/** Pick March, type the year, Continue → the confirmation step. */
function answer(screen: ReturnType<typeof renderScreen>, year: string) {
  fireEvent.press(screen.getByLabelText('Month: March'));
  fireEvent.changeText(screen.getByTestId('age-year-input'), year);
  fireEvent.press(screen.getByTestId('age-continue'));
}

describe('AgeConfirmationScreen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    setSessionHooks({ remoteLogout: () => Promise.resolve(), localCleanup: () => undefined });
    useAuthStore.setState({
      user: newcomer as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
      pendingLogin: { claimedInvite: true, wasManaged: true },
    });
  });

  it('asks neutrally: twelve month pills, a free year field, no minimum age anywhere', () => {
    const screen = renderScreen();
    expect(screen.getByText('When were you born?')).toBeTruthy();
    expect(screen.getByLabelText('Month: January')).toBeTruthy();
    expect(screen.getByLabelText('Month: December')).toBeTruthy();
    expect(screen.getByTestId('age-year-input').props.value).toBe('');
    // Nothing on the question suggests what answer is wanted.
    expect(screen.queryByText(/13/)).toBeNull();
    expect(screen.queryByText(/16/)).toBeNull();
    // Continue is disabled until both are entered.
    expect(screen.getByTestId('age-continue').props.accessibilityState?.disabled).toBe(true);
  });

  it('keeps the year to four digits and refuses an out-of-range one', () => {
    const screen = renderScreen();
    fireEvent.changeText(screen.getByTestId('age-year-input'), '19a90x');
    expect(screen.getByTestId('age-year-input').props.value).toBe('1990');
    fireEvent.changeText(screen.getByTestId('age-year-input'), '1850');
    fireEvent.press(screen.getByLabelText('Month: May'));
    expect(screen.getByTestId('age-continue').props.accessibilityState?.disabled).toBe(true);
  });

  it('repeats the entered month and year before sending, and lets the person change it', () => {
    const screen = renderScreen();
    answer(screen, '1990');
    expect(screen.getByText('Born in March 1990?')).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('age-confirm-change'));
    expect(screen.getByText('When were you born?')).toBeTruthy();
    // The entry survives the round trip.
    expect(screen.getByTestId('age-year-input').props.value).toBe('1990');
  });

  it('old enough: sends month, year and the device region once, confirms the store, fires the held-back sign-in analytics, and routes on', async () => {
    mockPost.mockResolvedValue({ data: { confirmed: true } });
    const screen = renderScreen();
    answer(screen, '1990');
    fireEvent.press(screen.getByTestId('age-confirm-submit'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/onboarding/role'));
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/auth/age-confirmation', { birthMonth: 3, birthYear: 1990, regionCode: 'US' });
    expect(useAuthStore.getState().user?.ageConfirmed).toBe(true);
    expect(useAuthStore.getState().pendingLogin).toBeNull();
    // The sign-in analytics that setUser held back, with the outcome it kept.
    expect(identifyUser).toHaveBeenCalledWith('u-new', expect.objectContaining({ role: 'PLAYER' }));
    expect(trackEvent).toHaveBeenCalledWith('user_logged_in', { claimed_invite: true, was_managed: true });
    expect(trackEvent).toHaveBeenCalledWith('age_confirmed');
    // Nothing about the answer reaches analytics.
    expect(JSON.stringify((trackEvent as jest.Mock).mock.calls)).not.toContain('1990');
  });

  it('under the minimum: explains, and Done ends the session with no analytics event', async () => {
    mockPost.mockRejectedValue(refusal());
    const screen = renderScreen();
    answer(screen, String(new Date().getUTCFullYear() - 8));
    fireEvent.press(screen.getByTestId('age-confirm-submit'));

    await waitFor(() => expect(screen.getByText('Thanks for letting us know')).toBeTruthy());
    expect(screen.getByText(/ages 13 and up/)).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(identifyUser).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('age-refused-done'));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('any other failure keeps the question and the session', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500 } }));
    const screen = renderScreen();
    answer(screen, '1990');
    fireEvent.press(screen.getByTestId('age-confirm-submit'));

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Born in March 1990?')).toBeTruthy());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user?.ageConfirmed).toBe(false);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
