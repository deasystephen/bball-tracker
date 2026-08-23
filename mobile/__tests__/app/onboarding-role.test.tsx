/**
 * Role-select screen — where it sends the user after "Continue".
 *
 * Regression: on first login the previous stack entry is the login screen, so
 * `router.back()` dumped a freshly signed-in coach on the sign-in page. Only
 * the Profile → "Change account type" path (`?from=profile`) may pop back.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import RoleSelectScreen from '../../app/onboarding/role';
import { useAuthStore } from '../../store/auth-store';
import { markRoleChosen } from '../../utils/role-onboarding';

const mockParams: { from?: string } = {};
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockPatch = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../services/api-client', () => ({ apiClient: { patch: (...a: unknown[]) => mockPatch(...a) } }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../utils/role-onboarding', () => ({
  ...jest.requireActual('../../utils/role-onboarding'),
  markRoleChosen: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../i18n', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const player = { id: 'u1', email: 'a@b.c', name: 'A', role: 'PLAYER' as const };

describe('RoleSelectScreen navigation after Continue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete mockParams.from;
    mockRouter.canGoBack.mockReturnValue(true);
    mockPatch.mockResolvedValue({ data: { user: { ...player, role: 'COACH' } } });
    useAuthStore.setState({ user: player as never, isAuthenticated: true, accessToken: 't', refreshToken: null, isLoading: false });
  });

  it('replaces to Home on the first-login path even when the stack can go back', async () => {
    const { getByText } = render(<RoleSelectScreen />);
    fireEvent.press(getByText('roleOnboarding.coachTitle'));
    fireEvent.press(getByText('roleOnboarding.continue'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockPatch).toHaveBeenCalledWith('/auth/me/role', { role: 'COACH' });
    expect(markRoleChosen).toHaveBeenCalledWith('u1');
    expect(useAuthStore.getState().user?.role).toBe('COACH');
  });

  it('pops back when opened from Profile', async () => {
    mockParams.from = 'profile';
    const { getByText } = render(<RoleSelectScreen />);
    fireEvent.press(getByText('roleOnboarding.coachTitle'));
    fireEvent.press(getByText('roleOnboarding.continue'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('falls back to Home from Profile when there is nothing to go back to', async () => {
    mockParams.from = 'profile';
    mockRouter.canGoBack.mockReturnValue(false);
    const { getByText } = render(<RoleSelectScreen />);
    fireEvent.press(getByText('roleOnboarding.playerTitle'));
    fireEvent.press(getByText('roleOnboarding.continue'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    // Same role as current → no API call.
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
