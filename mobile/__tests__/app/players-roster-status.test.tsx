/**
 * Manage Players screen — unified Add Player + invite-status chips
 * (roster/invite unification spec). Chips derive from the team payload's
 * invitations join; Resend/Invite are the supersede create; cancel targets
 * the PENDING row; case-3 invitees render in their own section, deduped
 * against members.
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
  useTeamInvitations: () => ({ data: { invitations: mockTeamInvitations } }),
  useCreateInvitation: () => mockCreateInvitation,
  useCancelInvitation: () => mockCancelInvitation,
}));
jest.mock('../../hooks/usePlayers', () => ({
  ...jest.requireActual('../../hooks/usePlayers'),
  usePlayers: () => ({ data: { players: [] }, isLoading: false }),
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
  ],
  invitations: [
    { id: 'inv-accepted', playerId: 'p-accepted', status: 'ACCEPTED', expiresAt: PAST, createdAt: PAST },
    { id: 'inv-invited', playerId: 'p-invited', status: 'PENDING', expiresAt: FUTURE, createdAt: PAST },
    { id: 'inv-expired', playerId: 'p-expired', status: 'PENDING', expiresAt: PAST, createdAt: PAST },
  ],
});

const signInCoach = () => {
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'c@x.y', name: 'Coach' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('ManagePlayersScreen — roster status and actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = baseTeam();
    mockTeamInvitations = [];
    signInCoach();
  });

  it('renders the correct chip for every roster state', () => {
    const { getAllByText, getByText } = render(<ManagePlayersScreen />);
    // Ada claimed + Bea web-link-accepted are both Active
    expect(getAllByText('Active')).toHaveLength(2);
    expect(getByText('Invited')).toBeTruthy();
    expect(getByText('Invite expired')).toBeTruthy();
    expect(getByText('Not invited')).toBeTruthy();
  });

  it('Resend calls the supersede create for an invited player', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: true });
    const { getByLabelText } = render(<ManagePlayersScreen />);

    fireEvent.press(getByLabelText('Resend invitation: Cleo Invited'));

    await waitFor(() =>
      expect(mockCreateInvitation.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: { playerId: 'p-invited', supersede: true },
      })
    );
    expect(mockShowToast).toHaveBeenCalledWith('Invitation re-sent to Cleo Invited', 'success');
  });

  it('a failed resend email surfaces as an error toast', async () => {
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: false });
    const { getByLabelText } = render(<ManagePlayersScreen />);

    fireEvent.press(getByLabelText('Resend invitation: Dot Expired'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Invitation refreshed, but the email to Dot Expired failed to send.',
        'error'
      )
    );
  });

  it('Cancel invitation confirms, then deletes the PENDING row by id', async () => {
    mockCancelInvitation.mutateAsync.mockResolvedValue({});
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByLabelText } = render(<ManagePlayersScreen />);

    fireEvent.press(getByLabelText('Cancel invitation: Cleo Invited'));

    expect(alertSpy).toHaveBeenCalled();
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    const confirm = buttons.find((b) => b.text === 'Cancel invitation');
    await confirm?.onPress?.();

    expect(mockCancelInvitation.mutateAsync).toHaveBeenCalledWith({
      invitationId: 'inv-invited',
      teamId: 't1',
    });
  });

  it('cancel button only renders on Invited rows — never Expired/Not invited/Active', () => {
    const { getByLabelText, queryByLabelText } = render(<ManagePlayersScreen />);
    expect(getByLabelText('Cancel invitation: Cleo Invited')).toBeTruthy();
    expect(queryByLabelText('Cancel invitation: Dot Expired')).toBeNull();
    expect(queryByLabelText('Cancel invitation: Eve RosterOnly')).toBeNull();
    expect(queryByLabelText('Cancel invitation: Ada Active')).toBeNull();
    // Eve has no email on file — no Invite action either
    expect(queryByLabelText('Invite: Eve RosterOnly')).toBeNull();
  });

  it('renders case-3 invitees (existing accounts) in their own section, deduped against members', () => {
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
    ];
    const { getByText, getAllByText } = render(<ManagePlayersScreen />);

    expect(getByText('Invited (1)')).toBeTruthy();
    expect(getByText('Zoe Existing')).toBeTruthy();
    // Cleo appears exactly once (in the members list), not again as case-3
    expect(getAllByText('Cleo Invited')).toHaveLength(1);
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

  it('a failed player invite email on add surfaces as an error toast', async () => {
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
        'The invitation email failed to send — use Resend on the roster to retry.',
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
});
