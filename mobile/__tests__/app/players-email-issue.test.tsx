/**
 * Manage Players screen — "this address bounced" (#449).
 *
 * The team payload carries what SES reported for each rostered player's
 * address. A flagged row shows a second chip and the address itself; an
 * unclaimed player's row offers "Fix email address", which corrects the
 * address and — when the player is still waiting on an invitation — sends it
 * in the same step.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import ManagePlayersScreen from '../../app/teams/[id]/players';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamMember, TeamStaff } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockCreateInvitation = { mutateAsync: jest.fn(), isPending: false };
const mockUpdatePlayer = { mutateAsync: jest.fn(), isPending: false };
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
jest.mock('../../services/upload-service', () => ({ uploadAvatar: jest.fn() }));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
  useAddRosterPlayer: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRemovePlayerFromTeam: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdateTeamMember: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../hooks/useInvitations', () => ({
  ...jest.requireActual('../../hooks/useInvitations'),
  useTeamInvitations: () => ({ data: { invitations: [] }, error: null, refetch: jest.fn() }),
  useCreateInvitation: () => mockCreateInvitation,
  useCancelInvitation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../hooks/usePlayers', () => ({
  ...jest.requireActual('../../hooks/usePlayers'),
  usePlayers: () => ({ data: { players: [] }, isLoading: false }),
  useUpdatePlayer: () => mockUpdatePlayer,
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
const BOUNCED_AT = '2026-09-27T18:00:00.000Z';

const makeMember = (
  playerId: string,
  name: string,
  player: Partial<TeamMember['player']> = {}
): TeamMember => ({
  id: `m-${playerId}`,
  playerId,
  jerseyNumber: 12,
  position: 'Guard',
  player: { id: playerId, name, isManaged: true, email: `${playerId}@exmaple.com`, ...player },
});

const bounced = { emailSuppressedAt: BOUNCED_AT, emailSuppressedReason: 'BOUNCE' as const };
const complained = { emailSuppressedAt: BOUNCED_AT, emailSuppressedReason: 'COMPLAINT' as const };

const baseTeam = (): Team => ({
  id: 't1',
  name: 'Spartans 5/6',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  staff: [{ id: 'ts-coach', userId: 'coach-1', user: { id: 'coach-1', name: 'Coach' }, role: headRole }],
  members: [
    makeMember('invited', 'Ivy Invited', bounced),
    makeMember('expired', 'Eli Expired', bounced),
    makeMember('never', 'Nia NotInvited', complained),
    makeMember('accepted', 'Abe WebAccept', bounced),
    makeMember('claimed', 'Cam Claimed', { ...bounced, isManaged: false }),
    makeMember('healthy', 'Hal Healthy'),
    makeMember('noemail', 'Noe NoEmail', { ...bounced, email: null }),
    makeMember('deleted', 'Deleted user', { ...bounced, deletedAt: BOUNCED_AT }),
  ],
  invitations: [
    { id: 'inv-invited', playerId: 'invited', status: 'PENDING', expiresAt: FUTURE, createdAt: PAST },
    { id: 'inv-expired', playerId: 'expired', status: 'PENDING', expiresAt: PAST, createdAt: PAST },
    { id: 'inv-accepted', playerId: 'accepted', status: 'ACCEPTED', expiresAt: PAST, createdAt: PAST },
  ],
});

const openFixEmail = (screen: ReturnType<typeof render>, playerName: string): void => {
  fireEvent.press(screen.getByLabelText(`Player options: ${playerName}`));
  fireEvent.press(screen.getByText('Fix email address'));
};

const forbidden = (): Error =>
  Object.assign(new Error('You can only update your own profile'), {
    apiError: { status: 403, error: 'You can only update your own profile' },
  });

describe('ManagePlayersScreen — email delivery issues (#449)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = baseTeam();
    mockUpdatePlayer.isPending = false;
    mockUpdatePlayer.mutateAsync.mockResolvedValue({});
    mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: true });
    useAuthStore.setState({
      user: { id: 'coach-1', role: 'COACH', email: 'x@y.z', name: 'X' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
  });

  describe('the chip', () => {
    it('marks a bounced and a blocked address, anchored to the row', () => {
      const screen = render(<ManagePlayersScreen />);

      expect(screen.getByLabelText('Ivy Invited email: Email bounced')).toBeTruthy();
      expect(screen.getByLabelText('Nia NotInvited email: Email blocked')).toBeTruthy();
      // A claimed account's address can bounce too; the coach should know.
      expect(screen.getByLabelText('Cam Claimed email: Email bounced')).toBeTruthy();
    });

    it('sits beside the invite-status chip, never in place of it', () => {
      const screen = render(<ManagePlayersScreen />);

      expect(screen.getByLabelText('Ivy Invited status: Invited')).toBeTruthy();
      expect(screen.getByLabelText('Eli Expired status: Invite expired')).toBeTruthy();
      expect(screen.getByLabelText('Eli Expired email: Email bounced')).toBeTruthy();
    });

    it('is absent for a healthy address, a player with no address, and a deleted account', () => {
      const screen = render(<ManagePlayersScreen />);

      expect(screen.queryByLabelText(/^Hal Healthy email:/)).toBeNull();
      expect(screen.queryByLabelText(/^Noe NoEmail email:/)).toBeNull();
      expect(screen.queryByLabelText(/^Deleted user email:/)).toBeNull();
      // Exactly the five flagged rows that still have an address and an account.
      expect(screen.queryAllByLabelText(/ email: Email /)).toHaveLength(5);
    });

    it('shows the address on its own full-width line under a flagged row, and keeps jersey and position', () => {
      const screen = render(<ManagePlayersScreen />);

      // The typo is the thing to look at. Beside two chips it truncated to
      // "xander.ex…" on a phone, so it sits on its own line, cut in the middle
      // when it must be cut at all.
      const address = screen.getByText('invited@exmaple.com');
      expect(address.props.numberOfLines).toBe(1);
      expect(address.props.ellipsizeMode).toBe('middle');

      expect(screen.queryByText('healthy@exmaple.com')).toBeNull();
      // Every row keeps its jersey line, flagged or not: 8 members, 8 lines.
      expect(screen.getAllByText('#12 • Guard')).toHaveLength(8);
    });
  });

  describe('Fix email address', () => {
    it('is offered first, for unclaimed players with a flagged address only', () => {
      const screen = render(<ManagePlayersScreen />);
      const offered = (playerName: string): boolean => {
        fireEvent.press(screen.getByLabelText(`Player options: ${playerName}`));
        const present = screen.queryByText('Fix email address') !== null;
        fireEvent.press(screen.getByLabelText('Close'));
        return present;
      };

      expect(offered('Ivy Invited')).toBe(true);
      expect(offered('Nia NotInvited')).toBe(true);
      expect(offered('Abe WebAccept')).toBe(true);
      // A claimed account's email belongs to its login.
      expect(offered('Cam Claimed')).toBe(false);
      expect(offered('Hal Healthy')).toBe(false);
      expect(offered('Noe NoEmail')).toBe(false);
    });

    it('opens prefilled with the flagged address and says what happened', () => {
      const screen = render(<ManagePlayersScreen />);

      openFixEmail(screen, 'Ivy Invited');

      expect(screen.getByText('Email for Ivy Invited')).toBeTruthy();
      expect(screen.getByTestId('edit-player-email-input').props.value).toBe('invited@exmaple.com');
      expect(screen.getByText(/bounced, so invitations are not reaching it/)).toBeTruthy();
    });

    it('explains a complaint differently', () => {
      const screen = render(<ManagePlayersScreen />);

      openFixEmail(screen, 'Nia NotInvited');

      expect(screen.getByText(/reported our mail as spam/)).toBeTruthy();
    });

    it.each([
      ['the unchanged address', 'invited@exmaple.com'],
      ['the unchanged address in another case', ' Invited@Exmaple.COM '],
      ['an empty input', ''],
      ['something that is not an address', 'invited at example'],
      ['an address with a space in it', 'in vited@example.com'],
    ])('does not save %s', (_label, value) => {
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, 'Ivy Invited');

      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), value);
      fireEvent.press(screen.getByTestId('edit-player-email-save'));

      expect(mockUpdatePlayer.mutateAsync).not.toHaveBeenCalled();
    });

    it.each([
      ['invited', 'Ivy Invited'],
      ['expired', 'Eli Expired'],
      ['never', 'Nia NotInvited'],
    ])('saves the corrected address, then sends the invitation (%s)', async (playerId, playerName) => {
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, playerName);

      expect(screen.getByText('Save & send invitation')).toBeTruthy();
      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), ` ${playerId}@Example.com `);
      fireEvent.press(screen.getByTestId('edit-player-email-save'));

      await waitFor(() => expect(mockCreateInvitation.mutateAsync).toHaveBeenCalled());
      // Trimmed and lower-cased, like every address the backend stores.
      expect(mockUpdatePlayer.mutateAsync).toHaveBeenCalledWith({
        playerId,
        data: { email: `${playerId}@example.com` },
      });
      expect(mockCreateInvitation.mutateAsync).toHaveBeenCalledWith({
        teamId: 't1',
        data: { playerId, supersede: true },
      });
      expect(mockUpdatePlayer.mutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateInvitation.mutateAsync.mock.invocationCallOrder[0]
      );
      expect(mockShowToast).toHaveBeenCalledWith(`Invitation re-sent to ${playerName}`, 'success');
      await waitFor(() => expect(screen.queryByTestId('edit-player-email-save')).toBeNull());
    });

    it('only saves for a player who already accepted: there is no invitation to send', async () => {
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, 'Abe WebAccept');

      expect(screen.queryByText('Save & send invitation')).toBeNull();
      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), 'abe@example.com');
      fireEvent.press(screen.getByTestId('edit-player-email-save'));

      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith('Email address updated', 'success')
      );
      expect(mockCreateInvitation.mutateAsync).not.toHaveBeenCalled();
    });

    it('reports a failed invitation email after the address was saved', async () => {
      mockCreateInvitation.mutateAsync.mockResolvedValue({ emailSent: false });
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, 'Ivy Invited');

      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), 'ivy@example.com');
      fireEvent.press(screen.getByTestId('edit-player-email-save'));

      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          'Invitation refreshed, but the email to Ivy Invited failed to send.',
          'error'
        )
      );
    });

    it('a 403 names the real rule, sends nothing, and keeps the sheet open', async () => {
      mockUpdatePlayer.mutateAsync.mockRejectedValue(forbidden());
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, 'Ivy Invited');

      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), 'ivy@example.com');
      fireEvent.press(screen.getByTestId('edit-player-email-save'));

      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          'Only the coach who added Ivy Invited can change this email address.',
          'error'
        )
      );
      expect(mockCreateInvitation.mutateAsync).not.toHaveBeenCalled();
      expect(screen.getByTestId('edit-player-email-save')).toBeTruthy();
    });

    it.each([
      ['the API message', new Error('A user with this email already exists'), 'A user with this email already exists'],
      ['a fallback for a non-Error', 'boom', 'Failed to update email address'],
    ])('any other failure surfaces %s', async (_label, failure, message) => {
      mockUpdatePlayer.mutateAsync.mockRejectedValue(failure);
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, 'Ivy Invited');

      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), 'ivy@example.com');
      fireEvent.press(screen.getByTestId('edit-player-email-save'));

      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(message, 'error'));
      expect(mockCreateInvitation.mutateAsync).not.toHaveBeenCalled();
    });

    it('Cancel closes the sheet without saving', () => {
      const screen = render(<ManagePlayersScreen />);
      openFixEmail(screen, 'Ivy Invited');

      fireEvent.changeText(screen.getByTestId('edit-player-email-input'), 'ivy@example.com');
      fireEvent.press(screen.getByText('Cancel'));

      expect(screen.queryByTestId('edit-player-email-save')).toBeNull();
      expect(mockUpdatePlayer.mutateAsync).not.toHaveBeenCalled();
    });
  });

  it('renders no email chip when the payload carries no delivery state (older backend, non-manager strip)', () => {
    mockTeam!.members = [makeMember('plain', 'Pat Plain')];
    const screen = render(<ManagePlayersScreen />);

    expect(screen.getByLabelText('Pat Plain status: Not invited')).toBeTruthy();
    expect(screen.queryAllByLabelText(/ email: Email /)).toHaveLength(0);
  });
});
