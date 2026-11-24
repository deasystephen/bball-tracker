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
import type { Team, TeamMember, TeamStaff } from '../../hooks/useTeams';
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
let mockLinkPoll: boolean | undefined;
let mockLinkError: Error | null = null;
let mockRequestsError: Error | null = null;
let mockRequestsUnloaded = false;
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
  useJoinLink: (_teamId: string, enabled: boolean, options?: { poll?: boolean }) => {
    mockLinkEnabled = enabled;
    mockLinkPoll = options?.poll;
    return { data: enabled ? mockLink : undefined, isLoading: false, error: mockLinkError, refetch: jest.fn() };
  },
  useJoinRequests: (_teamId: string, enabled: boolean, options?: { poll?: boolean }) => {
    mockRequestsEnabled = enabled;
    mockRequestsPoll = options?.poll;
    return {
      data: enabled && !mockRequestsUnloaded ? mockRequests : undefined,
      error: mockRequestsError,
      refetch: mockRefetchRequests,
    };
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
    mockLinkError = null;
    mockRequestsError = null;
    mockRequestsUnloaded = false;
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

    // Untouched settings are the API's defaults: 14 days, no cap (what the link always did).
    await waitFor(() =>
      expect(mockCreate.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', data: { expiresInDays: 14, maxUses: null } })
    );
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Join link created', 'success'));
  });

  it('creates a link with a custom expiry and request limit picked from the presets (#1073)', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockCreate.mutateAsync.mockResolvedValueOnce({ ...link, maxUses: 20 });
    const { getByText, getByLabelText, getByTestId } = render(<TeamJoinLinkScreen />);

    expect(getByText('Link settings')).toBeTruthy();
    expect(getByText('How long the link works')).toBeTruthy();
    expect(getByText('How many requests it takes')).toBeTruthy();
    expect(getByText("Declined requests don't count toward the limit.")).toBeTruthy();
    // The defaults are selected, and "No limit" is a choice of its own.
    expect(getByLabelText('Link works for 14 days').props.accessibilityState).toEqual({ selected: true });
    expect(getByLabelText('Request limit: No limit').props.accessibilityState).toEqual({ selected: true });
    expect(getByLabelText('Link works for 1 day').props.accessibilityState).toEqual({ selected: false });

    fireEvent.press(getByLabelText('Link works for 7 days'));
    fireEvent.press(getByLabelText('Request limit: 20'));
    expect(getByLabelText('Link works for 7 days').props.accessibilityState).toEqual({ selected: true });
    expect(getByLabelText('Link works for 14 days').props.accessibilityState).toEqual({ selected: false });
    expect(getByLabelText('Request limit: 20').props.accessibilityState).toEqual({ selected: true });

    fireEvent.press(getByTestId('join-link-create'));

    await waitFor(() =>
      expect(mockCreate.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', data: { expiresInDays: 7, maxUses: 20 } })
    );

    // Back to no limit: the cap is sent as null.
    fireEvent.press(getByLabelText('Request limit: No limit'));
    fireEvent.press(getByLabelText('Link works for 30 days'));
    fireEvent.press(getByTestId('join-link-create'));
    await waitFor(() =>
      expect(mockCreate.mutateAsync).toHaveBeenLastCalledWith({
        teamId: 't1',
        data: { expiresInDays: 30, maxUses: null },
      })
    );
  });

  it('New link uses the settings picked for it, in Spanish too', async () => {
    await i18n.changeLanguage('es');
    try {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockLink = link;
      mockCreate.mutateAsync.mockResolvedValueOnce({ ...link, id: 'link-2' });
      const alertSpy = jest.spyOn(Alert, 'alert');
      const { getByText, getByLabelText, getByTestId } = render(<TeamJoinLinkScreen />);

      expect(getByText('Opciones para un enlace nuevo')).toBeTruthy();
      fireEvent.press(getByLabelText('El enlace funciona durante 1 día'));
      fireEvent.press(getByLabelText('Límite de solicitudes: 50'));
      fireEvent.press(getByTestId('join-link-rotate'));
      await pressAlertButton(alertSpy, alertSpy.mock.calls[0][2]?.[1]?.text as string);

      expect(mockCreate.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', data: { expiresInDays: 1, maxUses: 50 } });
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('shows how many spots of a capped link are taken (pending plus approved, from the server)', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = { ...link, maxUses: 10, useCount: 4 };
    const { getByText } = render(<TeamJoinLinkScreen />);

    expect(getByText('4 of 10 spots taken.')).toBeTruthy();
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
    expect(mockCreate.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', data: { expiresInDays: 14, maxUses: null } });
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('New link created. The old one no longer works.', 'success')
    );
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
    // Both the link and the list are re-read while the coach is on this screen:
    // the server, not the device clock, says when the link stops being live.
    expect(mockRequestsPoll).toBe(true);
    expect(mockLinkPoll).toBe(true);
  });

  it('never judges expiry from the device clock: a link the server still serves keeps its QR code', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    // A phone whose clock runs ahead sees a past expiresAt on a link that is still live.
    mockLink = { ...link, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const { getByTestId, queryByTestId } = render(<TeamJoinLinkScreen />);

    expect(getByTestId('join-link-qr')).toBeTruthy();
    // Creating a link revokes the live one, so it must not be offered here.
    expect(queryByTestId('join-link-create')).toBeNull();
  });

  it('a failed re-read keeps the link, its QR code and the requests on screen', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    mockRequests = [childRequest];
    mockLinkError = new Error('Network Error');
    mockRequestsError = new Error('Network Error');
    const { getByTestId, getByLabelText, queryByText } = render(<TeamJoinLinkScreen />);

    expect(getByTestId('join-link-qr')).toBeTruthy();
    expect(getByLabelText('Approve Riley Park')).toBeTruthy();
    expect(queryByText("Couldn't load the requests to join.")).toBeNull();
    expect(queryByText('Something went wrong')).toBeNull();
  });

  it('shows the load errors only when nothing was ever loaded', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    mockLink = link;
    mockRequestsUnloaded = true;
    mockRequestsError = new Error('Network Error');
    const requestsFailed = render(<TeamJoinLinkScreen />);
    expect(requestsFailed.getByText("Couldn't load the requests to join.")).toBeTruthy();
    expect(requestsFailed.getByTestId('join-link-qr')).toBeTruthy();
    requestsFailed.unmount();

    mockLink = undefined as never;
    mockLinkError = new Error('Network Error');
    const linkFailed = render(<TeamJoinLinkScreen />);
    expect(linkFailed.getByText('Something went wrong')).toBeTruthy();
    expect(linkFailed.queryByTestId('join-link-qr')).toBeNull();
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

  describe('approving a child onto a player already on the roster (#1072)', () => {
    const member = (playerId: string, name: string, extra: Partial<TeamMember['player']> = {}): TeamMember => ({
      id: `m-${playerId}`,
      playerId,
      jerseyNumber: null,
      player: { id: playerId, name, email: null, isManaged: true, deletedAt: null, ...extra },
    });
    const rosterTeam: Team = {
      ...baseTeam,
      members: [
        member('p-alex', 'Alex Kim'),
        member('p-riley', 'riley  park'),
        // Already has a parent linked: not offered.
        member('p-jo', 'Jo Lee'),
        // Has their own login: not offered.
        member('p-sam', 'Sam Self', { isManaged: false, email: 'sam.self@example.com' }),
        // A deleted account's roster entry: not offered.
        member('p-gone', 'Gone Player', { deletedAt: '2026-11-01T00:00:00Z' }),
      ],
      guardianLinkedPlayerIds: ['p-jo'],
    };

    it('Approve asks which: a new player, or one of the records without a parent, the same name first', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = rosterTeam;
      mockRequests = [childRequest];
      mockApprove.mutateAsync.mockResolvedValueOnce(undefined);
      const { getByLabelText, getByText, getAllByRole, queryByText } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Approve Riley Park'));

      expect(getByText('Add Riley Park to the roster')).toBeTruthy();
      expect(mockApprove.mutateAsync).not.toHaveBeenCalled();
      const labels = getAllByRole('button').map((node) => node.props.accessibilityLabel as string);
      const offered = labels.filter((label) => label === 'Add as a new player' || /^Same child as /.test(label));
      expect(offered).toEqual([
        'Add as a new player',
        'Same child as riley  park, already on the roster',
        'Same child as Alex Kim, already on the roster',
      ]);
      expect(queryByText(/Jo Lee/)).toBeNull();
      expect(queryByText(/Sam Self/)).toBeNull();
      expect(queryByText(/Gone Player/)).toBeNull();

      fireEvent.press(getByLabelText('Same child as riley  park, already on the roster'));

      await waitFor(() =>
        expect(mockApprove.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', request: childRequest, playerId: 'p-riley' })
      );
      expect(mockShowToast).toHaveBeenCalledWith('Pat Park is now linked to riley  park', 'success');
    });

    it('two records with the same name are two rows, told apart by the jersey (0 included)', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = {
        ...baseTeam,
        members: [
          member('p-twin-b', 'Riley Park'),
          { ...member('p-twin-a', 'Riley Park'), jerseyNumber: 0 },
        ],
        guardianLinkedPlayerIds: [],
      };
      mockRequests = [childRequest];
      mockApprove.mutateAsync.mockResolvedValueOnce(undefined);
      const consoleError = jest.spyOn(console, 'error');
      const { getByLabelText, getAllByRole } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Approve Riley Park'));

      const offered = getAllByRole('button')
        .map((node) => node.props.accessibilityLabel as string)
        .filter((label) => /^Same child as /.test(label));
      // The numbered record sorts first (same name, then jersey, nulls last).
      expect(offered).toEqual([
        'Same child as Riley Park (#0), already on the roster',
        'Same child as Riley Park, already on the roster',
      ]);
      // No duplicate React keys.
      expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/);

      fireEvent.press(getByLabelText('Same child as Riley Park, already on the roster'));

      await waitFor(() =>
        expect(mockApprove.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', request: childRequest, playerId: 'p-twin-b' })
      );
    });

    it('records that would read alike are not offered: one line says why, and the rest of the menu is unchanged (#1110)', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = {
        ...baseTeam,
        members: [member('p-x', 'Riley Park'), member('p-y', 'Riley Park'), member('p-z', 'Alex Kim')],
        guardianLinkedPlayerIds: [],
      };
      mockRequests = [childRequest];
      mockApprove.mutateAsync.mockResolvedValue(undefined);
      const consoleError = jest.spyOn(console, 'error');
      const { getByLabelText, getAllByLabelText, queryByLabelText, getAllByRole } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Approve Riley Park'));

      // Neither twin is a choice; one note stands in for both.
      expect(queryByLabelText('Same child as Riley Park, already on the roster')).toBeNull();
      const note =
        'More than one player on the roster is named Riley Park. Give each a jersey number to tell them apart, then approve again.';
      expect(getAllByLabelText(note)).toHaveLength(1);
      // The note is text, not a button, and pressing it approves nothing.
      expect(getByLabelText(note).props.accessibilityRole).toBe('text');
      expect(getAllByRole('button').map((node) => node.props.accessibilityLabel as string)).not.toContain(note);
      fireEvent.press(getByLabelText(note));
      expect(mockApprove.mutateAsync).not.toHaveBeenCalled();
      expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/);

      // A record that reads differently from every other is offered as before, with nothing added.
      fireEvent.press(getByLabelText('Same child as Alex Kim, already on the roster'));
      await waitFor(() =>
        expect(mockApprove.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', request: childRequest, playerId: 'p-z' })
      );
    });

    it('with only look-alike records, the menu still offers a new player', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = {
        ...baseTeam,
        members: [member('p-x', 'Riley Park'), member('p-y', 'Riley Park')],
        guardianLinkedPlayerIds: [],
      };
      mockRequests = [childRequest];
      mockApprove.mutateAsync.mockResolvedValueOnce(undefined);
      const { getByLabelText } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Approve Riley Park'));
      fireEvent.press(getByLabelText('Add as a new player'));

      await waitFor(() => expect(mockApprove.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockApprove.mutateAsync.mock.calls[0][0].playerId).toBeUndefined();
    });

    it('"Add as a new player" approves as before', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = rosterTeam;
      mockRequests = [childRequest];
      mockApprove.mutateAsync.mockResolvedValueOnce(undefined);
      const { getByLabelText } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Approve Riley Park'));
      fireEvent.press(getByLabelText('Add as a new player'));

      await waitFor(() => expect(mockApprove.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockApprove.mutateAsync.mock.calls[0][0]).toEqual({ teamId: 't1', request: childRequest });
      expect(mockApprove.mutateAsync.mock.calls[0][0].playerId).toBeUndefined();
      expect(mockShowToast).toHaveBeenCalledWith('Riley Park was added to the roster', 'success');
    });

    it('a record taken meanwhile: the server\'s 409 message is shown and the list re-read', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = rosterTeam;
      mockRequests = [childRequest];
      mockApprove.mutateAsync.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: 'That player already has a parent or guardian linked. Choose another player or add a new one.',
            code: 'join_player_unavailable',
            reason: 'has_guardian',
          },
        },
      });
      const { getByLabelText } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Approve Riley Park'));
      fireEvent.press(getByLabelText('Same child as Alex Kim, already on the roster'));

      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error'));
      expect(mockRefetchRequests).toHaveBeenCalled();
    });

    it('a SELF request, or a roster with no such record, approves at once with no menu', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = rosterTeam;
      mockRequests = [selfRequest];
      mockApprove.mutateAsync.mockResolvedValue(undefined);
      const self = render(<TeamJoinLinkScreen />);
      fireEvent.press(self.getByLabelText('Approve Sam Teen'));
      await waitFor(() => expect(mockApprove.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', request: selfRequest }));
      expect(self.queryByText('Add as a new player')).toBeNull();
      self.unmount();

      mockTeam = { ...rosterTeam, guardianLinkedPlayerIds: ['p-jo', 'p-alex', 'p-riley'] };
      mockRequests = [childRequest];
      const child = render(<TeamJoinLinkScreen />);
      fireEvent.press(child.getByLabelText('Approve Riley Park'));
      await waitFor(() => expect(mockApprove.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', request: childRequest }));
      expect(child.queryByText('Add as a new player')).toBeNull();
    });

    it('offers the choice in Spanish', async () => {
      signIn({ id: 'coach-1', role: 'COACH' });
      mockTeam = rosterTeam;
      mockRequests = [childRequest];
      await i18n.changeLanguage('es');
      const { getByLabelText, getByText } = render(<TeamJoinLinkScreen />);

      fireEvent.press(getByLabelText('Aprobar a Riley Park'));

      expect(getByText('Agregar a Riley Park a la plantilla')).toBeTruthy();
      expect(getByText('Agregar como jugador nuevo')).toBeTruthy();
      expect(getByText('Es Alex Kim, que ya está en la plantilla')).toBeTruthy();
    });
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
