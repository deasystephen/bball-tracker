/**
 * Profile → Settings → Reply notifications (#34): the switch reflects
 * `user.notifyOnReplies` (undefined reads as on, the server default) and
 * saves through PATCH /auth/me.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import Profile from '../../app/(tabs)/profile';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
const mockUpdateProfile = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeams: () => ({ data: [] }),
}));
jest.mock('../../hooks/useUsage', () => ({ useUsage: () => ({ data: undefined }) }));
jest.mock('../../hooks/useProfile', () => ({
  useUpdateProfile: () => mockUpdateProfile,
}));

const signIn = (notifyOnReplies?: boolean) => {
  useAuthStore.setState({
    user: { id: 'frank', role: 'COACH', email: 'frank@example.com', name: 'Frank Vogel', notifyOnReplies } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('Profile reply notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateProfile.mutateAsync.mockResolvedValue(undefined);
  });

  it('reads as on when the API never sent the field, and turns it off on tap', async () => {
    signIn(undefined);
    const { getByTestId, getByText } = render(<Profile />);

    const toggle = getByTestId('reply-notifications-toggle');
    expect(toggle.props.accessibilityState.checked).toBe(true);
    expect(getByText('Push and email when someone replies to your announcements')).toBeTruthy();

    fireEvent.press(toggle);

    await waitFor(() => expect(mockUpdateProfile.mutateAsync).toHaveBeenCalledWith({ notifyOnReplies: false }));
  });

  it('shows off and turns it back on', async () => {
    signIn(false);
    const { getByTestId, getByText } = render(<Profile />);

    expect(getByTestId('reply-notifications-toggle').props.accessibilityState.checked).toBe(false);
    expect(getByText('Off')).toBeTruthy();

    fireEvent.press(getByTestId('reply-notifications-toggle'));

    await waitFor(() => expect(mockUpdateProfile.mutateAsync).toHaveBeenCalledWith({ notifyOnReplies: true }));
  });
});
