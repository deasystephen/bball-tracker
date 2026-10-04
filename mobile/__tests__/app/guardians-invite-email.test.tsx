/**
 * Player guardians screen — invite toast reflects the per-send `emailSent`
 * flag (#770). A failed SES send creates the pending invitation but must be
 * reported as an error, never as a green "Invitation sent".
 *
 * Renders the real i18n instance (docs/testing/conventions.md).
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import PlayerGuardiansScreen from '../../app/teams/[id]/players/[playerId]/guardians';
import { useAuthStore } from '../../store/auth-store';
import { i18n } from '../../i18n';

const mockShowToast = jest.fn();
const mockInvite = { mutateAsync: jest.fn(), isPending: false };
const mockRemove = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 't1', playerId: 'steph' }),
}));
jest.mock('../../hooks/useGoBack', () => ({ useGoBack: () => jest.fn() }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({
    data: {
      id: 't1',
      name: 'Warriors',
      staff: [{ userId: 'coach-1', role: { canManageRoster: true } }],
      members: [{ playerId: 'steph', player: { id: 'steph', name: 'Steph Curry' } }],
    },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
}));
jest.mock('../../hooks/useGuardians', () => ({
  ...jest.requireActual('../../hooks/useGuardians'),
  usePlayerGuardians: () => ({
    data: { guardians: [], pendingInvitations: [] },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useInviteGuardian: () => mockInvite,
  useRemoveGuardian: () => mockRemove,
}));

const pending = {
  id: 'gi1',
  invitedEmail: 'sonya.curry@example.test',
  relationship: 'MOTHER',
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};

async function submitInvite() {
  const screen = render(<PlayerGuardiansScreen />);
  fireEvent.press(screen.getByText('Invite a parent'));
  fireEvent.changeText(screen.getByTestId('guardian-email-input'), 'sonya.curry@example.test');
  fireEvent.press(screen.getByTestId('guardian-invite-submit'));
  await waitFor(() => expect(mockInvite.mutateAsync).toHaveBeenCalled());
  return screen;
}

describe('PlayerGuardiansScreen invite toast', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      user: { id: 'coach-1', role: 'COACH', email: 'coach@example.test', name: 'Coach' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  it('shows only the success toast when the email went out', async () => {
    mockInvite.mutateAsync.mockResolvedValueOnce({ invitation: pending, emailSent: true });
    const screen = await submitInvite();

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Invitation sent to sonya.curry@example.test', 'success')
    );
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    // Form closed: the email input is gone.
    expect(screen.queryByTestId('guardian-email-input')).toBeNull();
  });

  it('shows an error toast, never the green "sent" toast, when emailSent is false', async () => {
    mockInvite.mutateAsync.mockResolvedValueOnce({ invitation: pending, emailSent: false });
    const screen = await submitInvite();

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Invitation created, but the email to sonya.curry@example.test failed to send.',
        'error'
      )
    );
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    // The pending invitation exists server-side, so the form still closes.
    expect(screen.queryByTestId('guardian-email-input')).toBeNull();
  });
});
