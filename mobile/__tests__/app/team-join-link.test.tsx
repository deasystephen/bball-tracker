/**
 * Team join link screen (`/teams/:id/join-link`, #210): the link and QR code a
 * coach shares, and the requests waiting for approval. Only callers who may
 * manage the roster get the link or the requests. Rendered with the real i18n
 * instance.
 */

import { Alert, Share } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import TeamJoinLinkScreen from '../../app/teams/[id]/join-link';
import { i18n } from '../../i18n';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamStaff } from '../../hooks/useTeams';
import type { JoinLink, JoinRequestRow } from '../../hooks/useJoinLink';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockCreate = { mutateAsync: jest.fn(), isPending: false };
const mockRevoke = { mutateAsync: jest.fn(), isPending: false };
const mockApprove = { mutateAsync: jest.fn(), isPending: false };
const mockDecline = { mutateAsync: jest.fn(), isPending: false };
const mockRefetchRequests = jest.fn();
let mockLink: JoinLink | null = null;
let mockRequests: JoinRequestRow[] = [];
let mockLinkEnabled: boolean | undefined;
let mockRequestsEnabled: boolean | undefined;
let mockRequestsPoll: boolean | undefined;
let mockTeam: Team | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  getApiErrorMessage: jest.requireActual('../../services/api-client').getApiErrorMessage,
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useJoinLink', () => ({
  ...jest.requireActual('../../hooks/useJoinLink'),
  useJoinLink: (_teamId: string, enabled: boolean) => {
    mockLinkEnabled = enabled;
    return { data: enabled ? mockLink : undefined, isLoading: false, error: null, refetch: jest.fn() };
  },
  useJoinRequests: (_teamId: string, enabled: boolean, options?: { poll?: boolean }) => {
    mockRequestsEnabled = enabled;
    mockRequestsPoll = options?.poll;
    return { data: enabled ? mockRequests : undefined, error: null, refetch: mockRefetchRequests };
  },
  useCreateJoinLink: () => mockCreate,
  useRevokeJoinLink: () => mockRevoke,
  useApproveJoinRequest: () => mockApprove,
  useDeclineJoinRequest: () => mockDecline,
}));

const TOKEN = 'joinSecretToken_0123456789abcdefghijklmnopq';
const URL = `https://hooplings.com/join/${TOKEN}`;

const headRole: TeamStaff['role'] = {
  id: 'r-head',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

const baseTeam: Team = {
  id: 't1',
  name: 'Lakers',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  staff: [
    {
      id: 'ts-coach-1',
      userId: 'coach-1',
      user: { id: 'coach-1', name: 'Frank Vogel', email: 'frank@example.com', isManaged: false, deletedAt: null },
      role: headRole,
    } as TeamStaff,
  ],
};

const link: JoinLink = {
  id: 'link-1',
  teamId: 't1',
  url: URL,
  // Always in the future, whenever the suite runs.
  expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
  maxUses: null,
  useCount: 3,
  createdAt: '2026-11-22T12:00:00Z',
};

const childRequest: JoinRequestRow = {
  id: 'req-child',
  kind: 'CHILD',
  status: 'PENDING',
  createdAt: '2026-11-22T12:00:00Z',
  childName: 'Riley Park',
  relationship: 'MOTHER',
  requester: { id: 'u-parent', name: 'Pat Park', email: 'pat@example.com', isManaged: false, deletedAt: null },
};

const selfRequest: JoinRequestRow = {
  id: 'req-self',
  kind: 'SELF',
  status: 'PENDING',
  createdAt: '2026-11-22T13:00:00Z',
  childName: null,
  relationship: null,
  requester: { id: 'u-teen', name: 'Sam Teen', email: 'sam@example.com', isManaged: false, deletedAt: null },
};

const signIn = (user: { id: string; role: 'PLAYER' | 'COACH' | 'ADMIN' }) => {
  useAuthStore.setState({
    user: { ...user, email: 'x@y.z', name: 'X' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

/** Press the dialog button with this label on the most recent Alert. */
async function pressAlertButton(alertSpy: jest.SpyInstance, label: string): Promise<void> {
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  const buttons = alertSpy.mock.calls[alertSpy.mock.calls.length - 1][2] as { text: string; onPress?: () => unknown }[];
  await buttons.find((b) => b.text === label)!.onPress!();
}

describe('TeamJoinLinkScreen (#210)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = baseTeam;
    mockLink = null;
    mockRequests = [];
    mockLinkEnabled = undefined;
    mockRequestsEnabled = undefined;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('a member who cannot manage the roster gets neither the link nor the requests', () => {
    signIn({ id: 'player-1', role: 'PLAYER' });
    const { getByText, queryByTestId } = render(<TeamJoinLinkScreen />);

    expect(getByText("Only coaches who manage this team's roster can use the join link.")).toBeTruthy();
    expect(mockLinkEnabled).toBe(false);
    expect(mockRequestsEnabled).toBe(false);
    expect(queryByTestId('join-link-create')).toBeNull();
    expect(queryByTestId('join-link-qr')).toBeNull();
  });

  it('with no link yet: explains that requests need approval and offers to create one', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockCreate.mutateAsync.mockResolvedValueOnce(link);
    const { getByText, getByTestId, queryByTestId } = render(<TeamJoinLinkScreen />);

    expect(
      getByText(
        'Share one link with your team so families can add themselves. Anyone who opens it can only ask to join: nobody is added until you approve the request.'
      )
    ).toBeTruthy();
    expect(queryByTestId('join-link-qr')).toBeNull();

    fireEvent.press(getByTestId('join-link-create'));

    await waitFor(() => expect(mockCreate.mutateAsync).toHaveBeenCalledWith({ teamId: 't1' }));
  });

  it('with a link: shows the QR code of the URL and shares the URL, which is never printed as text', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const { getByTestId, getByLabelText, queryByText, UNSAFE_getByType } = render(<TeamJoinLinkScreen />);

    expect(getByLabelText('QR code to join Lakers')).toBeTruthy();
    // The code that is drawn is the code of this URL.
    const { qrPath } = jest.requireActual('../../utils/qr-path');
    const drawn = UNSAFE_getByType('Path' as never).props.d as string;
    expect(drawn).toBe(qrPath(URL).path);
    expect(queryByText(new RegExp(TOKEN))).toBeNull();

    fireEvent.press(getByTestId('join-link-share'));

    await waitFor(() =>
      expect(shareSpy).toHaveBeenCalledWith({ message: `Join Lakers on Hooplings: ${URL}` })
    );
  });

  it('New link asks first, because the current link and code stop working', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    mockCreate.mutateAsync.mockResolvedValueOnce({ ...link, id: 'link-2' });
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByTestId } = render(<TeamJoinLinkScreen />);

    fireEvent.press(getByTestId('join-link-rotate'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe('Create a new link?');
    expect(alertSpy.mock.calls[0][1]).toBe(
      'The current link and QR code stop working right away. Requests already waiting stay on this list.'
    );
    expect(mockCreate.mutateAsync).not.toHaveBeenCalled();
    await pressAlertButton(alertSpy, 'Create new link');
    expect(mockCreate.mutateAsync).toHaveBeenCalledWith({ teamId: 't1' });
  });

  it('Turn off revokes after a confirmation', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    mockRevoke.mutateAsync.mockResolvedValueOnce(undefined);
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByTestId } = render(<TeamJoinLinkScreen />);

    fireEvent.press(getByTestId('join-link-revoke'));
    await pressAlertButton(alertSpy, 'Turn off link');

    expect(mockRevoke.mutateAsync).toHaveBeenCalledWith({ teamId: 't1' });
    expect(mockShowToast).toHaveBeenCalledWith('Join link turned off', 'success');
  });

  it('says a capped link is full instead of when it expires', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = { ...link, maxUses: 3, useCount: 3 };
    const { getByText, queryByText } = render(<TeamJoinLinkScreen />);

    expect(
      getByText('This link has reached its limit (3 requests). Create a new link to let more people ask.')
    ).toBeTruthy();
    expect(queryByText(/This link works until/)).toBeNull();
  });

  it('lists who is asking: a child with the parent and relationship, a player as themself', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    mockRequests = [childRequest, selfRequest];
    const { getByText } = render(<TeamJoinLinkScreen />);

    expect(getByText('2 waiting')).toBeTruthy();
    expect(getByText('Riley Park')).toBeTruthy();
    expect(getByText("Added by Pat Park, the player's mother")).toBeTruthy();
    // The address is a line of its own, so a long detail never cuts it off.
    expect(getByText('pat@example.com')).toBeTruthy();
    expect(getByText('Sam Teen')).toBeTruthy();
    expect(getByText('Player, joining as themself')).toBeTruthy();
    expect(getByText('sam@example.com')).toBeTruthy();
    // The list polls while the coach is on this screen.
    expect(mockRequestsPoll).toBe(true);
  });

  it('a link that expired while cached is shown as no link, with a way to make a new one', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = { ...link, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const { getByText, getByTestId, queryByTestId } = render(<TeamJoinLinkScreen />);

    expect(getByText('This link has expired. Create a new one to share.')).toBeTruthy();
    expect(getByTestId('join-link-create')).toBeTruthy();
    expect(queryByTestId('join-link-qr')).toBeNull();
    expect(queryByTestId('join-link-share')).toBeNull();
  });

  it('approving adds the player and says who was added', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockRequests = [childRequest];
    mockApprove.mutateAsync.mockResolvedValueOnce(undefined);
    const { getByLabelText } = render(<TeamJoinLinkScreen />);

    fireEvent.press(getByLabelText('Approve Riley Park'));

    await waitFor(() => expect(mockApprove.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', request: childRequest }));
    expect(mockShowToast).toHaveBeenCalledWith('Riley Park was added to the roster', 'success');
  });

  it('a failed approval shows the error and re-reads the list', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockRequests = [selfRequest];
    mockApprove.mutateAsync.mockRejectedValueOnce(new Error('nope'));
    const { getByLabelText } = render(<TeamJoinLinkScreen />);

    fireEvent.press(getByLabelText('Approve Sam Teen'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error'));
    expect(mockRefetchRequests).toHaveBeenCalled();
  });

  it('declining asks first and adds nobody', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockRequests = [selfRequest];
    mockDecline.mutateAsync.mockResolvedValueOnce(undefined);
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByLabelText } = render(<TeamJoinLinkScreen />);

    fireEvent.press(getByLabelText('Decline Sam Teen'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][1]).toBe('Sam Teen will not be added to the roster.');
    expect(mockDecline.mutateAsync).not.toHaveBeenCalled();
    await pressAlertButton(alertSpy, 'Decline');
    expect(mockDecline.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', requestId: 'req-self' });
    expect(mockApprove.mutateAsync).not.toHaveBeenCalled();
  });

  it('renders in Spanish', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    mockRequests = [childRequest];
    await i18n.changeLanguage('es');
    const { getByText, getByLabelText } = render(<TeamJoinLinkScreen />);

    expect(getByText('Enlace para unirse')).toBeTruthy();
    expect(getByText('Compartir enlace')).toBeTruthy();
    expect(getByLabelText('Código QR para unirse a Lakers')).toBeTruthy();
    expect(getByText('Agregado por Pat Park, madre del jugador')).toBeTruthy();
    expect(getByLabelText('Aprobar a Riley Park')).toBeTruthy();
  });
});
