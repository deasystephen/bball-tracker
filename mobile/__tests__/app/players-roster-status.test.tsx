/**
 * Manage Players screen — unified Add Player + invite-status chips
 * (roster/invite unification spec). Chips derive from the team payload's
 * invitations join; per-player actions live behind a 44pt overflow menu
 * (Resend/Invite are the supersede create, Cancel targets the PENDING row);
 * case-3 invitees render in their own section, deduped against members and
 * filtered to unexpired rows.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import ManagePlayersScreen from '../../app/teams/[id]/players';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamStaff } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockAddRosterPlayer = { mutateAsync: jest.fn(), isPending: false };
const mockCreateInvitation = { mutateAsync: jest.fn(), isPending: false };
const mockCancelInvitation = { mutateAsync: jest.fn(), isPending: false };
let mockTeam: Team | undefined;
let mockTeamInvitations: unknown[] = [];
let mockTeamInvitationsError: Error | null = null;
const mockRefetchTeamInvitations = jest.fn();
let mockPlayersList: { id: string; name: string; email?: string | null }[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../services/upload-service', () => ({ uploadAvatar: jest.fn() }));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
  useAddRosterPlayer: () => mockAddRosterPlayer,
  useRemovePlayerFromTeam: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useTeamInvitations: () => ({
    data: mockTeamInvitationsError ? undefined : { invitations: mockTeamInvitations },
    error: mockTeamInvitationsError,
    refetch: mockRefetchTeamInvitations,
  }),
  useCreateInvitation: () => mockCreateInvitation,
  useCancelInvitation: () => mockCancelInvitation,
}));
jest.mock('../../hooks/usePlayers', () => ({
  ...jest.requireActual('../../hooks/usePlayers'),
  usePlayers: () => ({ data: { players: mockPlayersList }, isLoading: false }),
}));

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

const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

const makeMember = (playerId: string, name: string, isManaged: boolean, email?: string) => ({
  id: `m-${playerId}`,
  playerId,
  jerseyNumber: null,
  position: null,
  player: { id: playerId, name, isManaged, email: email ?? null },
});

const baseTeam = (): Team => ({
  id: 't1',
  name: 'Spartans 5/6',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  staff: [
    {
      id: 'ts-coach',
      userId: 'coach-1',
      user: { id: 'coach-1', name: 'Coach' },
      role: headRole,
    },
  ],
  members: [
    makeMember('p-active', 'Ada Active', false, 'ada@example.com'),
    makeMember('p-accepted', 'Bea WebAccept', true, 'bea@example.com'),
    makeMember('p-invited', 'Cleo Invited', true, 'cleo@example.com'),
    makeMember('p-expired', 'Dot Expired', true, 'dot@example.com'),
    makeMember('p-none', 'Eve RosterOnly', true),
    makeMember('p-hasmail', 'Fay NotInvited', true, 'fay@example.com'),
  ],
  invitations: [
    { id: 'inv-accepted', playerId: 'p-accepted', status: 'ACCEPTED', expiresAt: PAST, createdAt: PAST },
    { id: 'inv-invited', playerId: 'p-invited', status: 'PENDING', expiresAt: FUTURE, createdAt: PAST },
    { id: 'inv-expired', playerId: 'p-expired', status: 'PENDING', expiresAt: PAST, createdAt: PAST },
  ],
});

const signIn = (user: { id: string; role: 'PLAYER' | 'COACH' | 'ADMIN' }) => {
  useAuthStore.setState({
    user: { ...user, email: 'x@y.z', name: 'X' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

type AlertButton = { text: string; style?: string; onPress?: () => void | Promise<void> };

/** Open a member's overflow menu (an ActionMenu bottom sheet, not an Alert —
 * Android caps Alert at three buttons). Items are real pressables. */
const openMenu = (screen: ReturnType<typeof render>, playerName: string): void => {
  fireEvent.press(screen.getByLabelText(`Player options: ${playerName}`));
};

const MENU_LABELS = [
  'Resend invitation',
  'Send invitation',
  'Cancel invitation',
  'Invite a parent',
  'Remove player',
];

const visibleMenuItems = (screen: ReturnType<typeof render>): string[] =>
  MENU_LABELS.filter((label) => screen.queryByText(label) !== null);

const closeMenu = (screen: ReturnType<typeof render>): void => {
  fireEvent.press(screen.getByLabelText('Close'));
};

describe('ManagePlayersScreen — roster status and actions', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = baseTeam();
    mockTeamInvitations = [];
    mockTeamInvitationsError = null;
    mockPlayersList = [];
    mockAddRosterPlayer.isPending = false;
    alertSpy = jest.spyOn(Alert, 'alert');
    signIn({ id: 'coach-1', role: 'COACH' });
  });

  it('renders the correct chip for every roster state', () => {
    const { getAllByText, getByText } = render(<ManagePlayersScreen />);
    // Ada claimed + Bea web-link-accepted are both Active
    expect(getAllByText('Active')).toHaveLength(2);
    expect(getByText('Invited')).toBeTruthy();
    expect(getByText('Invite expired')).toBeTruthy();
    // Eve (no email) and Fay (email, never invited) are both Not invited
    expect(getAllByText('Not invited')).toHaveLength(2);
  });

  it('menu contents are contextual to the chip status', () => {
    const screen = render(<ManagePlayersScreen />);

    // Invited: resend + cancel; managed → invite a parent
    openMenu(screen, 'Cleo Invited');
    expect(visibleMenuItems(screen)).toEqual([
      'Resend invitation',
      'Cancel invitation',
      'Invite a parent',
      'Remove player',
    ]);
    closeMenu(screen);

    // Expired: resend but NO cancel (lazily-expired rows have no valid id)
    openMenu(screen, 'Dot Expired');
    expect(visibleMenuItems(screen)).toEqual([
      'Resend invitation',
      'Invite a parent',
      'Remove player',
    ]);
    closeMenu(screen);

    // No email on file: no send option at all
    openMenu(screen, 'Eve RosterOnly');
    expect(visibleMenuItems(screen)).toEqual(['Invite a parent', 'Remove player']);
    closeMenu(screen);

    // Not invited WITH an email: Send invitation appears
    openMenu(screen, 'Fay NotInvited');
    expect(visibleMenuItems(screen)).toContain('Send invitation');
    closeMenu(screen);

    // Active claimed account (not managed): only remove
    openMenu(screen, 'Ada Active');
    expect(visibleMenuItems(screen)).toEqual(['Remove player']);
  });

  it('Resend calls the supersede create for an invited player', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: true });
    const screen = render(<ManagePlayersScreen />);

    openMenu(screen, 'Cleo Invited');
    fireEvent.press(screen.getByText('Resend invitation'));

    await waitFor(() =>
      expect(mockCreateInvitation.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: { playerId: 'p-invited', supersede: true },
      })
    );
    expect(mockShowToast).toHaveBeenCalledWith('Invitation re-sent to Cleo Invited', 'success');
  });

  it('Send invitation for a not-invited player with an email uses the same supersede call', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: true });
    const screen = render(<ManagePlayersScreen />);

    openMenu(screen, 'Fay NotInvited');
    fireEvent.press(screen.getByText('Send invitation'));

    await waitFor(() =>
      expect(mockCreateInvitation.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: { playerId: 'p-hasmail', supersede: true },
      })
    );
  });

  it('a failed resend email surfaces as an error toast', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: false });
    const screen = render(<ManagePlayersScreen />);

    openMenu(screen, 'Dot Expired');
    fireEvent.press(screen.getByText('Resend invitation'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Invitation refreshed, but the email to Dot Expired failed to send.',
        'error'
      )
    );
  });

  it('emailSent null (no address on file) surfaces as an info toast', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: null });
    const screen = render(<ManagePlayersScreen />);

    openMenu(screen, 'Cleo Invited');
    fireEvent.press(screen.getByText('Resend invitation'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Cleo Invited has no email address on file.',
        'info'
      )
    );
  });

  it('a rejected resend surfaces the API error message', async () => {
    mockCreateInvitation.mutateAsync.mockRejectedValue(
      new Error('A pending invitation already exists for this player')
    );
    const screen = render(<ManagePlayersScreen />);

    openMenu(screen, 'Cleo Invited');
    fireEvent.press(screen.getByText('Resend invitation'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'A pending invitation already exists for this player',
        'error'
      )
    );
  });

  it('Cancel invitation confirms, then deletes the PENDING row scoped to the team', async () => {
    mockCancelInvitation.mutateAsync.mockResolvedValue({});
    const screen = render(<ManagePlayersScreen />);

    openMenu(screen, 'Cleo Invited');
    fireEvent.press(screen.getByText('Cancel invitation'));

    // The action opens its own confirm dialog (Alert, 2 buttons — Android-safe)
    const confirmCall = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    expect(confirmCall[0]).toBe('Cancel Invitation');
    const confirm = (confirmCall[2] as AlertButton[]).find((b) => b.text === 'Cancel invitation');
    await confirm?.onPress?.();

    expect(mockCancelInvitation.mutateAsync).toHaveBeenCalledWith({
      invitationId: 'inv-invited',
      teamId: 't1',
    });
  });

  it('renders case-3 invitees deduped against members and filtered to unexpired', () => {
    mockTeamInvitations = [
      {
        id: 'inv-case3',
        playerId: 'p-outsider',
        status: 'PENDING',
        expiresAt: FUTURE,
        player: { id: 'p-outsider', name: 'Zoe Existing', email: 'zoe@example.com' },
      },
      // Same-team pending invite for a rostered member must NOT duplicate
      {
        id: 'inv-invited',
        playerId: 'p-invited',
        status: 'PENDING',
        expiresAt: FUTURE,
        player: { id: 'p-invited', name: 'Cleo Invited', email: 'cleo@example.com' },
      },
      // Expired non-member invite must be filtered out
      {
        id: 'inv-stale',
        playerId: 'p-stale',
        status: 'PENDING',
        expiresAt: PAST,
        player: { id: 'p-stale', name: 'Stan Stale', email: 'stan@example.com' },
      },
    ];
    const { getByText, getAllByText, queryByText } = render(<ManagePlayersScreen />);

    expect(getByText('Invited (1)')).toBeTruthy();
    expect(getByText('Zoe Existing')).toBeTruthy();
    expect(queryByText('Stan Stale')).toBeNull();
    // Cleo appears exactly once (in the members list), not again as case-3
    expect(getAllByText('Cleo Invited')).toHaveLength(1);
  });

  it('case-3 row resend uses the direct button with the supersede call', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: true });
    mockTeamInvitations = [
      {
        id: 'inv-case3',
        playerId: 'p-outsider',
        status: 'PENDING',
        expiresAt: FUTURE,
        player: { id: 'p-outsider', name: 'Zoe Existing', email: 'zoe@example.com' },
      },
    ];
    const { getByLabelText } = render(<ManagePlayersScreen />);

    fireEvent.press(getByLabelText('Resend invitation: Zoe Existing'));

    await waitFor(() =>
      expect(mockCreateInvitation.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: { playerId: 'p-outsider', supersede: true },
      })
    );
  });

  it('unified Add Player posts the form and explains the case-3 outcome', async () => {
    mockAddRosterPlayer.mutateAsync.mockResolvedValue({
      success: true,
      rostered: false,
      invited: true,
      member: null,
      invitation: { id: 'inv-x' },
      guardianInvited: false,
      guardianReason: 'Guardians can be added after the player accepts the invitation and joins the roster',
      emails: { player: true },
    });
    const { getByTestId } = render(<ManagePlayersScreen />);

    fireEvent.press(getByTestId('add-player-button'));
    fireEvent.changeText(getByTestId('add-player-name-input'), 'Zoe');
    fireEvent.changeText(getByTestId('add-player-email-input'), 'zoe@example.com');
    fireEvent.changeText(getByTestId('add-player-guardian-email-input'), 'mom@example.com');
    fireEvent.press(getByTestId('add-player-submit'));

    await waitFor(() =>
      expect(mockAddRosterPlayer.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: expect.objectContaining({
          name: 'Zoe',
          playerEmail: 'zoe@example.com',
          guardianEmail: 'mom@example.com',
          guardianRelationship: 'GUARDIAN',
        }),
      })
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      "This email already has an account — invitation sent. They'll appear on the roster once they accept.",
      'info'
    );
    // Guardian deferral reason surfaces
    expect(mockShowToast).toHaveBeenCalledWith(
      'Guardians can be added after the player accepts the invitation and joins the roster',
      'info'
    );
  });

  it('case-2 success toasts "added and invitation sent"; failed player email adds an error toast', async () => {
    mockAddRosterPlayer.mutateAsync.mockResolvedValue({
      success: true,
      rostered: true,
      invited: true,
      member: makeMember('p-new', 'New Kid', true, 'new@example.com'),
      invitation: { id: 'inv-new' },
      guardianInvited: false,
      emails: { player: false },
    });
    const { getByTestId } = render(<ManagePlayersScreen />);

    fireEvent.press(getByTestId('add-player-button'));
    fireEvent.changeText(getByTestId('add-player-name-input'), 'New Kid');
    fireEvent.changeText(getByTestId('add-player-email-input'), 'new@example.com');
    fireEvent.press(getByTestId('add-player-submit'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Player added to roster and invitation sent',
        'success'
      )
    );
    expect(mockShowToast).toHaveBeenCalledWith(
      'The invitation email failed to send — use Resend on the roster to retry.',
      'error'
    );
  });

  it('a failed guardian email surfaces as an error toast', async () => {
    mockAddRosterPlayer.mutateAsync.mockResolvedValue({
      success: true,
      rostered: true,
      invited: true,
      member: makeMember('p-new', 'New Kid', true, 'new@example.com'),
      invitation: { id: 'inv-new' },
      guardianInvited: true,
      emails: { player: true, guardian: false },
    });
    const { getByTestId } = render(<ManagePlayersScreen />);

    fireEvent.press(getByTestId('add-player-button'));
    fireEvent.changeText(getByTestId('add-player-name-input'), 'New Kid');
    fireEvent.changeText(getByTestId('add-player-email-input'), 'new@example.com');
    fireEvent.changeText(getByTestId('add-player-guardian-email-input'), 'mom@example.com');
    fireEvent.press(getByTestId('add-player-submit'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'The parent invite email failed to send — retry from the player’s Guardians screen.',
        'error'
      )
    );
  });

  it('name-only add reports a plain roster success', async () => {
    mockAddRosterPlayer.mutateAsync.mockResolvedValue({
      success: true,
      rostered: true,
      invited: false,
      member: makeMember('p-kid', 'Kid', true),
      invitation: null,
      guardianInvited: false,
      emails: {},
    });
    const { getByTestId } = render(<ManagePlayersScreen />);

    fireEvent.press(getByTestId('add-player-button'));
    fireEvent.changeText(getByTestId('add-player-name-input'), 'Kid');
    fireEvent.press(getByTestId('add-player-submit'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Player added to roster', 'success')
    );
    expect(mockAddRosterPlayer.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      data: expect.objectContaining({ name: 'Kid', playerEmail: undefined, guardianEmail: undefined }),
    });
  });

  it('a rejected add surfaces the error and keeps the form open', async () => {
    mockAddRosterPlayer.mutateAsync.mockRejectedValue(new Error('Player is already on this team'));
    const { getByTestId } = render(<ManagePlayersScreen />);

    fireEvent.press(getByTestId('add-player-button'));
    fireEvent.changeText(getByTestId('add-player-name-input'), 'Dup Kid');
    fireEvent.press(getByTestId('add-player-submit'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Player is already on this team', 'error')
    );
    // Form stays open for correction
    expect(getByTestId('add-player-name-input')).toBeTruthy();
  });

  it('submit is inert while the add is pending (double-tap guard)', () => {
    mockAddRosterPlayer.isPending = true;
    const { getByTestId } = render(<ManagePlayersScreen />);

    fireEvent.press(getByTestId('add-player-button'));
    fireEvent.changeText(getByTestId('add-player-name-input'), 'Kid');
    fireEvent.press(getByTestId('add-player-submit'));

    expect(mockAddRosterPlayer.mutateAsync).not.toHaveBeenCalled();
  });

  it('search → select → Send Invitation flow, including a failed email warning', async () => {
    mockPlayersList = [{ id: 'p-search', name: 'Searched Sam', email: 'sam@example.com' }];
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: false });
    const { getByText, getByLabelText } = render(<ManagePlayersScreen />);

    fireEvent.changeText(getByLabelText('Search Players'), 'Sam');
    fireEvent.press(getByText('Searched Sam'));
    fireEvent.press(getByText('Send Invitation'));

    await waitFor(() =>
      expect(mockCreateInvitation.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: expect.objectContaining({ playerId: 'p-search' }),
      })
    );
    expect(mockShowToast).toHaveBeenCalledWith('Invitation sent to player', 'success');
    expect(mockShowToast).toHaveBeenCalledWith(
      'The invitation email failed to send — use Resend to retry.',
      'error'
    );
  });

  it('a failed invitations fetch renders an inline error with retry, not a vanished section', () => {
    mockTeamInvitationsError = new Error('network down');
    const { getByText, getByLabelText } = render(<ManagePlayersScreen />);

    getByText('Couldn\u2019t load pending invitations.');
    fireEvent.press(getByLabelText('Retry loading invitations'));
    expect(mockRefetchTeamInvitations).toHaveBeenCalled();
  });

  it('search results exclude players who already have a live case-3 invitation', () => {
    mockTeamInvitations = [
      {
        id: 'inv-pend',
        playerId: 'p-pend',
        status: 'PENDING',
        expiresAt: FUTURE,
        player: { id: 'p-pend', name: 'Pending Petra', email: 'petra@example.com' },
      },
    ];
    mockPlayersList = [
      { id: 'p-pend', name: 'Pending Petra', email: 'petra@example.com' },
      { id: 'p-search', name: 'Searched Sam', email: 'sam@example.com' },
    ];
    const { getByText, getByLabelText, queryAllByText } = render(<ManagePlayersScreen />);

    fireEvent.changeText(getByLabelText('Search Players'), 'Pe');
    // Petra renders once — her Invited row — never as a selectable search
    // result (selecting her would hit a bare 400: the pending invite exists)
    expect(queryAllByText('Pending Petra')).toHaveLength(1);
    expect(getByText('Searched Sam')).toBeTruthy();
  });

  it('denies a non-manager: no roster controls render and the screen bounces', async () => {
    signIn({ id: 'player-9', role: 'PLAYER' });
    const { queryByLabelText, queryByTestId } = render(<ManagePlayersScreen />);

    // The real useAccessGuard runs (not mocked): spinner instead of controls,
    // gated UI never flashes for an unauthorized deep link
    expect(queryByTestId('add-player-button')).toBeNull();
    expect(queryByLabelText('Player options: Cleo Invited')).toBeNull();
    await waitFor(() =>
      expect(mockRouter.back.mock.calls.length + mockRouter.replace.mock.calls.length).toBeGreaterThan(0)
    );
  });
});
