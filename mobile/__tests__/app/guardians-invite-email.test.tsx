/**
 * Player guardians screen — invite toast reflects the per-send `emailSent`
 * flag (#770). A failed SES send creates the pending invitation but must be
 * reported as an error, never as a green "Invitation sent", and points at
 * Resend (#420). Resend on a pending row is the invite call with
 * `supersede: true`.
 *
 * Renders the real i18n instance (docs/testing/conventions.md).
 */

import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

import PlayerGuardiansScreen from '../../app/teams/[id]/players/[playerId]/guardians';
import { useAuthStore } from '../../store/auth-store';
import { i18n } from '../../i18n';

const mockShowToast = jest.fn();
const mockInvite = { mutateAsync: jest.fn(), isPending: false };
const mockRemove = { mutateAsync: jest.fn(), isPending: false };
let mockGuardianData: { guardians: unknown[]; pendingInvitations: unknown[] } = {
  guardians: [],
  pendingInvitations: [],
};
let mockCanManageRoster = true;

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
// jest.setup mocks the whole api-client; keep the real error-message mapping
// so the refused-resend test asserts what production shows.
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  getApiErrorMessage: jest.requireActual('../../services/api-client').getApiErrorMessage,
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({
    data: {
      id: 't1',
      name: 'Warriors',
      staff: [{ userId: 'coach-1', role: { canManageRoster: mockCanManageRoster } }],
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
    data: mockGuardianData,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useInviteGuardian: () => mockInvite,
  useRemoveGuardian: () => mockRemove,
}));

const pending = {
  id: 'gi1',
  teamId: 't1',
  canResend: true,
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
        'Invitation created, but the email to sonya.curry@example.test failed to send. Resend on the pending invite becomes available in a couple of minutes.',
        'error'
      )
    );
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    // The pending invitation exists server-side, so the form still closes.
    expect(screen.queryByTestId('guardian-email-input')).toBeNull();
  });
});

describe('PlayerGuardiansScreen Resend (#420)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanManageRoster = true;
    mockGuardianData = { guardians: [], pendingInvitations: [pending] };
    useAuthStore.setState({
      user: { id: 'coach-1', role: 'COACH', email: 'coach@example.test', name: 'Coach' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  afterAll(() => {
    mockGuardianData = { guardians: [], pendingInvitations: [] };
  });

  it('resends the pending invitation with supersede and confirms the new send', async () => {
    mockInvite.mutateAsync.mockResolvedValueOnce({ invitation: pending, emailSent: true });
    const screen = render(<PlayerGuardiansScreen />);

    expect(screen.getByRole('button', { name: 'Resend invitation: sonya.curry@example.test' })).toBeTruthy();
    fireEvent.press(screen.getByTestId('guardian-resend-gi1'));

    await waitFor(() =>
      expect(mockInvite.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        playerId: 'steph',
        data: { email: 'sonya.curry@example.test', relationship: 'MOTHER', supersede: true },
      })
    );
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Invitation re-sent to sonya.curry@example.test', 'success')
    );
  });

  it('shows a spinner on the row in flight and ignores repeat taps until the resend settles', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockInvite.mutateAsync.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const screen = render(<PlayerGuardiansScreen />);

    fireEvent.press(screen.getByTestId('guardian-resend-gi1'));

    await waitFor(() => expect(screen.getByTestId('guardian-resending-gi1')).toBeTruthy());
    expect(screen.getByTestId('guardian-resend-gi1').props.accessibilityState).toEqual(
      expect.objectContaining({ busy: true, disabled: true })
    );
    fireEvent.press(screen.getByTestId('guardian-resend-gi1'));
    expect(mockInvite.mutateAsync).toHaveBeenCalledTimes(1);

    // Settle inside act so React flushes the handler's continuation (toast,
    // then the `finally` that clears the row's pending state) before the
    // assertions; a bare resolve left that to a later tick on a slow runner.
    await act(async () => {
      finish({ invitation: pending, emailSent: true });
    });
    // The toast proves the continuation ran; only then is the spinner checked.
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Invitation re-sent to sonya.curry@example.test', 'success')
    );
    expect(screen.queryByTestId('guardian-resending-gi1')).toBeNull();
  });

  it('reports a failed resend email as an error, never as "re-sent"', async () => {
    mockInvite.mutateAsync.mockResolvedValueOnce({ invitation: pending, emailSent: false });
    const screen = render(<PlayerGuardiansScreen />);

    fireEvent.press(screen.getByTestId('guardian-resend-gi1'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Invitation refreshed, but the email to sonya.curry@example.test failed to send. You can resend it again in a couple of minutes.',
        'error'
      )
    );
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
  });

  it('shows the server message when the resend is refused (cooldown)', async () => {
    // The api-client's response interceptor normalizes the body onto `apiError`.
    const cooldown = Object.assign(new Error('Request failed with status code 429'), {
      isAxiosError: true,
      response: { status: 429 },
      apiError: {
        error: 'An invitation was just sent to this address. Try again in 87 seconds.',
        code: 'resend_cooldown',
      },
    });
    mockInvite.mutateAsync.mockRejectedValueOnce(cooldown);
    const screen = render(<PlayerGuardiansScreen />);

    fireEvent.press(screen.getByTestId('guardian-resend-gi1'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'An invitation was just sent to this address. Try again in 87 seconds.',
        'error'
      )
    );
    expect(mockShowToast).not.toHaveBeenCalledWith(expect.anything(), 'success');
  });

  it('renders Resend from the server flag, not from the team id', () => {
    mockGuardianData = {
      guardians: [],
      pendingInvitations: [
        // Last season's team-season of this club (after a rollover): resendable.
        { ...pending, teamId: 'last-season' },
        // Another club's row: listed without the action.
        { ...pending, id: 'gi-other', teamId: 'other-club', canResend: false, invitedEmail: 'dell.curry@example.test' },
      ],
    };
    const screen = render(<PlayerGuardiansScreen />);

    expect(screen.getByTestId('guardian-resend-gi1')).toBeTruthy();
    expect(screen.getByText('dell.curry@example.test')).toBeTruthy();
    expect(screen.queryByTestId('guardian-resend-gi-other')).toBeNull();
  });

  it('keeps the invite form button idle while a resend is in flight', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockInvite.mutateAsync.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const screen = render(<PlayerGuardiansScreen />);

    fireEvent.press(screen.getByTestId('guardian-resend-gi1'));
    await waitFor(() => expect(screen.getByTestId('guardian-resending-gi1')).toBeTruthy());
    fireEvent.press(screen.getByText('Invite a parent'));

    const submit = screen.getByTestId('guardian-invite-submit');
    expect(submit.props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));

    // Same deterministic settle as the spinner test above.
    await act(async () => {
      finish({ invitation: pending, emailSent: true });
    });
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Invitation re-sent to sonya.curry@example.test', 'success')
    );
    expect(screen.queryByTestId('guardian-resending-gi1')).toBeNull();
  });

  it('renders no Resend for a viewer who cannot manage the roster', () => {
    mockCanManageRoster = false;
    useAuthStore.setState({
      user: { id: 'parent-1', role: 'PARENT', email: 'parent@example.test', name: 'Parent' } as never,
    });
    const screen = render(<PlayerGuardiansScreen />);

    expect(screen.getByText('sonya.curry@example.test')).toBeTruthy();
    expect(screen.queryByTestId('guardian-resend-gi1')).toBeNull();
  });
});
