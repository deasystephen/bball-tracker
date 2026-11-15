/**
 * Invitations tab — staff invitation cards (#460).
 *
 * A pending staff invitation addressed to the signed-in account renders with
 * the team and the role; Accept joins the staff (or says the existing role was
 * left as it was), Decline asks first. Rendered with the real i18n instance.
 */

import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import InvitationsScreen from '../../app/(tabs)/invitations';
import { useAuthStore } from '../../store/auth-store';
import type { InvitationsResponse, StaffInvitationView } from '../../hooks/useInvitations';

const mockShowToast = jest.fn();
const mockAccept = { mutateAsync: jest.fn(), isPending: false };
const mockReject = { mutateAsync: jest.fn(), isPending: false };
let mockData: InvitationsResponse | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  usePlayerInvitations: () => ({
    data: mockData,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    isRefetching: false,
  }),
  useAcceptInvitation: () => mockAccept,
  useRejectInvitation: () => mockReject,
}));

const staffInvite: StaffInvitationView = {
  kind: 'staff',
  id: 'si1',
  status: 'PENDING',
  teamName: 'Hornets',
  roleType: 'ASSISTANT_COACH',
  inviterName: 'Casey Head',
  inviterDeletedAt: null,
  expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
};

function withStaffInvite(overrides: Partial<StaffInvitationView> = {}): void {
  mockData = {
    success: true,
    invitations: [],
    staffInvitations: [{ ...staffInvite, ...overrides }],
    pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
  };
}

describe('InvitationsScreen staff invitations (#460)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      user: { id: 'u1', role: 'COACH', email: 'new.coach@example.com', name: 'Nia New' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  it('renders the team, the role and the sender, and counts the card', () => {
    withStaffInvite();
    const { getByText, getByTestId } = render(<InvitationsScreen />);
    expect(getByTestId('staff-invitation-si1')).toBeTruthy();
    expect(getByText('Hornets')).toBeTruthy();
    expect(getByText('Staff invitation: Assistant Coach')).toBeTruthy();
    expect(getByText(/Casey Head/)).toBeTruthy();
    expect(getByText('1 invitation')).toBeTruthy();
  });

  it('Accept joins the staff and says so with the role', async () => {
    withStaffInvite();
    mockAccept.mutateAsync.mockResolvedValueOnce({ success: true, kind: 'staff', alreadyStaff: false });
    const { getByTestId } = render(<InvitationsScreen />);

    fireEvent.press(getByTestId('staff-invitation-accept-si1'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('You joined Hornets as Assistant Coach', 'success')
    );
    expect(mockAccept.mutateAsync).toHaveBeenCalledWith('si1');
  });

  it('Accept on an account already on the staff says the role was not changed', async () => {
    withStaffInvite({ roleType: 'HEAD_COACH' });
    mockAccept.mutateAsync.mockResolvedValueOnce({ success: true, kind: 'staff', alreadyStaff: true });
    const { getByTestId } = render(<InvitationsScreen />);

    fireEvent.press(getByTestId('staff-invitation-accept-si1'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        "You're already on the Hornets staff. Your role was not changed.",
        'success'
      )
    );
  });

  it('Decline asks first, then rejects', async () => {
    withStaffInvite();
    mockReject.mutateAsync.mockResolvedValueOnce({ success: true, kind: 'staff' });
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByText } = render(<InvitationsScreen />);

    fireEvent.press(getByText('Decline'));
    expect(mockReject.mutateAsync).not.toHaveBeenCalled();
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => Promise<void> }[];
    await buttons.find((b) => (b as { style?: string }).style === 'destructive')!.onPress!();

    expect(mockReject.mutateAsync).toHaveBeenCalledWith('si1');
  });

  it('an expired invitation offers no Accept', () => {
    withStaffInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const { queryByTestId } = render(<InvitationsScreen />);
    expect(queryByTestId('staff-invitation-accept-si1')).toBeNull();
  });
});
