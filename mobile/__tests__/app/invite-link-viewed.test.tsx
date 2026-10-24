/**
 * Invite deep link analytics (#967):
 *   - `invite_link_viewed` fires once per token per mount with the state the
 *     screen shows, the invitation's kind, whether the invitee is signed in and
 *     where the link came from (`?src=web` from the web page's Open in App);
 *   - an accept failure goes through `getApiErrorMessage`, so it fires
 *     `error_shown` (code, status, route pattern; never the message);
 *   - Log In to Accept keeps `src` in the return path.
 */

import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { AxiosError } from 'axios';

import InviteDeepLinkScreen from '../../app/invite/[token]';
import { trackEvent } from '../../services/analytics';
import { useAuthStore } from '../../store/auth-store';
import { setPendingReturnPath } from '../../utils/return-path';
import { inviteLinkState } from '../../hooks/useInviteLinkViewed';
import type { InvitationByToken } from '../../hooks/useInvitationByToken';

let mockParams: { token: string; src?: string } = { token: 'tok-1' };
let mockQuery: { data?: InvitationByToken; isLoading: boolean; error: unknown; refetch: jest.Mock };
const mockShowToast = jest.fn();
const mockMutateAsync = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useInvitationByToken', () => ({
  ...jest.requireActual('../../hooks/useInvitationByToken'),
  useInvitationByToken: () => mockQuery,
}));
jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));
// jest.setup mocks the whole api-client; keep the real message and classification helpers.
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useAcceptInvitation: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
jest.mock('../../utils/return-path', () => ({ setPendingReturnPath: jest.fn(() => Promise.resolve()) }));

const mockedTrack = trackEvent as jest.Mock;
const viewed = () => mockedTrack.mock.calls.filter(([event]) => event === 'invite_link_viewed').map(([, props]) => props);

const future = () => new Date(Date.now() + 3 * 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();

const teamInvitation = (overrides: Record<string, unknown> = {}): InvitationByToken =>
  ({
    kind: 'team',
    id: 'inv-1',
    status: 'PENDING',
    teamName: 'Lakers',
    inviterName: 'Frank Vogel',
    inviterDeletedAt: null,
    position: null,
    jerseyNumber: null,
    message: null,
    expiresAt: future(),
    ...overrides,
  }) as InvitationByToken;

const guardianInvitation = (): InvitationByToken =>
  ({
    kind: 'guardian',
    id: 'gi-1',
    status: 'PENDING',
    childName: 'Steph Curry',
    childDeletedAt: null,
    teamName: 'Warriors',
    inviterName: 'Steve Kerr',
    inviterDeletedAt: null,
    relationship: 'FATHER',
    expiresAt: future(),
  }) as InvitationByToken;

const httpError = (status: number, data: Record<string, unknown> = {}) =>
  new AxiosError(`status ${status}`, 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    data,
    statusText: '',
    headers: {},
    config: {} as never,
  });

function showing(data: InvitationByToken | undefined, error: unknown = null) {
  mockQuery = { data, isLoading: false, error, refetch: jest.fn() };
}

describe('invite_link_viewed (#967)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { token: 'tok-1' };
    useAuthStore.setState({ isAuthenticated: false });
  });

  it.each([
    ['pending', teamInvitation()],
    ['expired', teamInvitation({ status: 'EXPIRED' })],
    ['expired', teamInvitation({ expiresAt: past() })],
    ['accepted', teamInvitation({ status: 'ACCEPTED' })],
    ['rejected', teamInvitation({ status: 'REJECTED' })],
    ['cancelled', teamInvitation({ status: 'CANCELLED' })],
  ])('reports %s once, with the kind', (state, invitation) => {
    showing(invitation);
    const { rerender } = render(<InviteDeepLinkScreen />);
    rerender(<InviteDeepLinkScreen />);

    expect(viewed()).toStrictEqual([{ state, kind: 'team', authenticated: false, source: 'link' }]);
  });

  it('reports not_found, with no kind, for a dead token', () => {
    showing(undefined, httpError(404));
    render(<InviteDeepLinkScreen />);
    expect(viewed()).toStrictEqual([{ state: 'not_found', authenticated: false, source: 'link' }]);
  });

  it('reports unavailable for a transient failure', () => {
    showing(undefined, httpError(503));
    render(<InviteDeepLinkScreen />);
    expect(viewed()).toStrictEqual([{ state: 'unavailable', authenticated: false, source: 'link' }]);
  });

  it('reports nothing while loading', () => {
    mockQuery = { data: undefined, isLoading: true, error: null, refetch: jest.fn() };
    render(<InviteDeepLinkScreen />);
    expect(viewed()).toEqual([]);
  });

  it('reports a guardian invitation, a signed-in invitee and the web source', () => {
    mockParams = { token: 'tok-1', src: 'web' };
    useAuthStore.setState({ isAuthenticated: true });
    showing(guardianInvitation());
    render(<InviteDeepLinkScreen />);
    expect(viewed()).toStrictEqual([{ state: 'pending', kind: 'guardian', authenticated: true, source: 'web' }]);
  });

  it('treats any other src as a plain link', () => {
    mockParams = { token: 'tok-1', src: 'email<script>' };
    showing(teamInvitation());
    render(<InviteDeepLinkScreen />);
    expect(viewed()[0]).toMatchObject({ source: 'link' });
    expect(JSON.stringify(mockedTrack.mock.calls)).not.toContain('script');
  });

  it('never sends the token, a name or the team', () => {
    showing(teamInvitation());
    render(<InviteDeepLinkScreen />);
    const sent = JSON.stringify(mockedTrack.mock.calls);
    expect(sent).not.toMatch(/tok-1|Lakers|Frank Vogel|inv-1/);
  });

  it('keeps src in the return path when a signed-out invitee taps Log In to Accept', async () => {
    mockParams = { token: 'tok-1', src: 'web' };
    showing(teamInvitation());
    const { getByText } = render(<InviteDeepLinkScreen />);

    fireEvent.press(getByText('Log In to Accept'));

    await waitFor(() => expect(setPendingReturnPath).toHaveBeenCalledWith('/invite/tok-1?src=web'));
  });

  it('keeps a plain return path for a plain link', async () => {
    showing(teamInvitation());
    const { getByText } = render(<InviteDeepLinkScreen />);

    fireEvent.press(getByText('Log In to Accept'));

    await waitFor(() => expect(setPendingReturnPath).toHaveBeenCalledWith('/invite/tok-1'));
  });
});

describe('invite accept failure (#967)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { token: 'tok-1' };
    useAuthStore.setState({ isAuthenticated: true });
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Accept')?.onPress?.();
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('fires error_shown and toasts the message from getApiErrorMessage', async () => {
    const error = httpError(409, { error: 'This invitation is for a different account', code: 'invitation_email_mismatch' });
    (error as AxiosError & { apiError?: unknown }).apiError = {
      error: 'This invitation is for a different account',
      code: 'invitation_email_mismatch',
      status: 409,
    };
    mockMutateAsync.mockRejectedValueOnce(error);
    showing(teamInvitation());
    const { getByText } = render(<InviteDeepLinkScreen />);

    fireEvent.press(getByText('Accept Invitation'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('This invitation is for a different account', 'error')
    );
    const shown = mockedTrack.mock.calls.filter(([event]) => event === 'error_shown').map(([, props]) => props);
    expect(shown).toEqual([{ code: 'invitation_email_mismatch', status: 409, endpoint_pattern: '' }]);
  });

  it('falls back to our copy when the failure carries no message', async () => {
    mockMutateAsync.mockRejectedValueOnce({});
    showing(teamInvitation());
    const { getByText } = render(<InviteDeepLinkScreen />);

    fireEvent.press(getByText('Accept Invitation'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to accept invitation', 'error'));
    expect(mockedTrack.mock.calls.some(([event]) => event === 'error_shown')).toBe(true);
  });
});

describe('inviteLinkState', () => {
  const base = { isLoading: false, failed: false, retrying: false, error: null, invitation: teamInvitation() };

  it('is null while loading or while Try Again is in flight', () => {
    expect(inviteLinkState({ ...base, isLoading: true })).toBeNull();
    expect(inviteLinkState({ ...base, failed: true, retrying: true })).toBeNull();
  });

  it('puts ACCEPTED ahead of an expiry date that has passed, as the screen does', () => {
    expect(inviteLinkState({ ...base, invitation: teamInvitation({ status: 'ACCEPTED', expiresAt: past() }) })).toBe(
      'accepted'
    );
  });
});
