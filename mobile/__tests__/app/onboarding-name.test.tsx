/**
 * Display-name screen — onboarding prompt vs Profile edit mode.
 *
 * Onboarding (no `from` param): shown once after login to accounts whose name
 * is still the email local part; Continue saves and replaces to Home, Skip
 * keeps the placeholder. Profile mode (`?from=profile`): pre-fills the current
 * name, Save pops back, Cancel discards. Both save via PATCH /auth/me.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import NamePromptScreen from '../../app/onboarding/name';
import { useAuthStore } from '../../store/auth-store';
import { createQueryWrapper } from '../utils/queryWrapper';
import { nameAskedKey } from '../../utils/role-onboarding';
import { setPendingReturnPath } from '../../utils/return-path';

const mockParams: { from?: string } = {};
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockPatch = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../services/api-client', () => ({ apiClient: { patch: (...a: unknown[]) => mockPatch(...a) } }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const coach = { id: 'u1', email: 'frank.vogel@example.com', name: 'frank.vogel', role: 'COACH' as const };

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(
    <Wrapper>
      <NamePromptScreen />
    </Wrapper>
  );
}

describe('NamePromptScreen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    delete mockParams.from;
    mockRouter.canGoBack.mockReturnValue(true);
    mockPatch.mockResolvedValue({
      data: { success: true, user: { ...coach, name: 'Frank Vogel', profilePictureUrl: null, createdAt: '' } },
    });
    useAuthStore.setState({
      user: coach as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  it('onboarding: saves the name, marks the prompt asked and replaces to Home', async () => {
    const { getByText, getByTestId } = renderScreen();
    // Placeholder names are never pre-filled.
    expect(getByTestId('name-onboarding-input').props.value).toBe('');

    fireEvent.changeText(getByTestId('name-onboarding-input'), 'Frank Vogel');
    fireEvent.press(getByText('Continue'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockPatch).toHaveBeenCalledWith('/auth/me', { name: 'Frank Vogel' });
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user?.name).toBe('Frank Vogel');
    await expect(AsyncStorage.getItem(nameAskedKey('u1'))).resolves.toBe('true');
  });

  it('onboarding: Skip keeps the placeholder but never asks again', async () => {
    const { getByText } = renderScreen();
    fireEvent.press(getByText('Skip for now'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockPatch).not.toHaveBeenCalled();
    await expect(AsyncStorage.getItem(nameAskedKey('u1'))).resolves.toBe('true');
  });

  it('onboarding: honours a pending deep link instead of forcing Home', async () => {
    await setPendingReturnPath('/invite/tok123');
    const { getByText, getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('name-onboarding-input'), 'Frank Vogel');
    fireEvent.press(getByText('Continue'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/invite/tok123'));
  });

  it('onboarding: rejects a blank name inline', async () => {
    const { getByText, getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('name-onboarding-input'), ' ');
    fireEvent.press(getByText('Continue'));

    await waitFor(() => expect(getByText('Please enter your name')).toBeTruthy());
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('profile mode: pre-fills a real name and pops back on save', async () => {
    mockParams.from = 'profile';
    useAuthStore.setState({ user: { ...coach, name: 'Frank Vogel' } as never });

    const { getByText, getByTestId } = renderScreen();
    expect(getByTestId('name-onboarding-input').props.value).toBe('Frank Vogel');
    expect(getByText('Edit your name')).toBeTruthy();

    fireEvent.changeText(getByTestId('name-onboarding-input'), 'Frank V. Vogel');
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(mockPatch).toHaveBeenCalledWith('/auth/me', { name: 'Frank V. Vogel' });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('profile mode: Cancel pops back without saving', async () => {
    mockParams.from = 'profile';
    const { getByText } = renderScreen();
    fireEvent.press(getByText('Cancel'));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('profile mode: falls back to Home when there is nothing to go back to', async () => {
    mockParams.from = 'profile';
    mockRouter.canGoBack.mockReturnValue(false);
    const { getByText, getByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('name-onboarding-input'), 'Frank Vogel');
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
