/**
 * Deep-link invitation screen (`/invite/<token>`) for a staff invitation
 * (#460): it names the team and the role (never a jersey or position), asks
 * a signed-out invitee to sign in with the invited address, and on accept
 * says which role was joined, or that an existing role was left unchanged.
 */

import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import InviteDeepLinkScreen from '../../app/invite/[token]';
import { i18n } from '../../i18n';
import { useAuthStore } from '../../store/auth-store';
import type { InvitationByToken } from '../../hooks/useInvitationByToken';

let mockInvitation: InvitationByToken | undefined;
const mockShowToast = jest.fn();
const mockReplace = jest.fn();
const mockAccept = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn() }),
  useLocalSearchParams: () => ({ token: 'tok-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useInvitationByToken', () => ({
  ...jest.requireActual('../../hooks/useInvitationByToken'),
  useInvitationByToken: () => ({ data: mockInvitation, isLoading: false, error: null }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useAcceptInvitation: () => mockAccept,
}));

const staffInvitation: InvitationByToken = {
  kind: 'staff',
  id: 'si-1',
  status: 'PENDING',
  teamName: 'Hornets',
  roleType: 'ASSISTANT_COACH',
  inviterName: 'Casey Head',
  inviterDeletedAt: null,
  expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
};

function signedIn(isAuthenticated: boolean): void {
  useAuthStore.setState({
    user: isAuthenticated ? ({ id: 'u1', role: 'COACH', email: 'a@b.c', name: 'A' } as never) : null,
    isAuthenticated,
    accessToken: isAuthenticated ? 't' : null,
    refreshToken: null,
    isLoading: false,
  });
}

/** Press Accept, then the confirm dialog's Accept. */
async function acceptThroughDialog(getByText: (text: string) => unknown): Promise<void> {
  const alertSpy = jest.spyOn(Alert, 'alert');
  fireEvent.press(getByText('Accept Invitation') as never);
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  const [, body, buttons] = alertSpy.mock.calls[0];
  expect(body).toBe('Join Hornets as Assistant Coach?');
  await (buttons as { text: string; onPress?: () => Promise<void> }[]).find((b) => b.text === 'Accept')!.onPress!();
}

describe('InviteDeepLinkScreen staff invitation (#460)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvitation = staffInvitation;
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names the team, the role and the sender; no jersey or position rows', () => {
    signedIn(true);
    const { getByText, queryByText } = render(<InviteDeepLinkScreen />);
    expect(getByText("You're invited to coach")).toBeTruthy();
    expect(getByText("Join the team's staff as Assistant Coach.")).toBeTruthy();
    expect(getByText('Hornets')).toBeTruthy();
    expect(getByText('Assistant Coach')).toBeTruthy();
    expect(getByText('Casey Head')).toBeTruthy();
    expect(queryByText('Jersey')).toBeNull();
  });

  it('renders in Spanish with the translated role', async () => {
    signedIn(true);
    await i18n.changeLanguage('es');
    const { getByText } = render(<InviteDeepLinkScreen />);
    expect(getByText('Te invitaron a entrenar')).toBeTruthy();
    expect(getByText('Únete al cuerpo técnico del equipo como Entrenador asistente.')).toBeTruthy();
  });

  it('asks a signed-out invitee to sign in with the invited address', () => {
    signedIn(false);
    const { getByText } = render(<InviteDeepLinkScreen />);
    expect(getByText('Sign in, or create an account, with the email address this invitation was sent to.')).toBeTruthy();
    expect(getByText('Log In to Accept')).toBeTruthy();
  });

  it('accepting joins the staff and goes to the Teams tab', async () => {
    signedIn(true);
    mockAccept.mutateAsync.mockResolvedValueOnce({ success: true, kind: 'staff', alreadyStaff: false });
    const { getByText } = render(<InviteDeepLinkScreen />);

    await acceptThroughDialog(getByText);

    expect(mockAccept.mutateAsync).toHaveBeenCalledWith('si-1');
    expect(mockShowToast).toHaveBeenCalledWith('You joined Hornets as Assistant Coach', 'success');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/teams');
  });

  it('says the role was not changed when the account was already on the staff', async () => {
    signedIn(true);
    mockAccept.mutateAsync.mockResolvedValueOnce({ success: true, kind: 'staff', alreadyStaff: true });
    const { getByText } = render(<InviteDeepLinkScreen />);

    await acceptThroughDialog(getByText);

    expect(mockShowToast).toHaveBeenCalledWith(
      "You're already on the Hornets staff. Your role was not changed.",
      'success'
    );
  });

  it('an already-accepted staff link goes to Teams (it is never listed again); an expired one asks the head coach', () => {
    signedIn(true);
    mockInvitation = { ...staffInvitation, status: 'ACCEPTED' } as InvitationByToken;
    const accepted = render(<InviteDeepLinkScreen />);
    fireEvent.press(accepted.getByText('Teams'));
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/teams');
    accepted.unmount();

    mockInvitation = { ...staffInvitation, expiresAt: new Date(Date.now() - 1000).toISOString() } as InvitationByToken;
    const expired = render(<InviteDeepLinkScreen />);
    expect(expired.getByText('Ask the head coach to send a new invitation.')).toBeTruthy();
  });
});
