/**
 * Team staff screen — mutating controls are gated on `canManageStaff`
 * (role matrix decision 2, B2.3): ADMIN, league admin or HEAD_COACH-type
 * staff row. Everyone with team access can read the list; a non-managing
 * staff member may still leave the team; the last head coach can never be
 * removed.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import TeamStaffScreen from '../../app/teams/[id]/staff';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamStaff } from '../../hooks/useTeams';
import type { TeamStaffRow } from '../../hooks/useTeamStaff';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockAddStaff = { mutateAsync: jest.fn(), isPending: false };
let mockTeam: Team | undefined;
let mockStaff: TeamStaffRow[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useTeamStaff', () => ({
  ...jest.requireActual('../../hooks/useTeamStaff'),
  useTeamStaff: () => ({ data: mockStaff, isLoading: false, error: null, refetch: jest.fn() }),
  useAddStaff: () => mockAddStaff,
  useUpdateStaffRole: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRemoveStaff: () => ({ mutateAsync: jest.fn(), isPending: false }),
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
const assistantRole: TeamStaff['role'] = { ...headRole, id: 'r-asst', name: 'Assistant Coach', type: 'ASSISTANT_COACH' };

const makeRow = (userId: string, name: string, role: TeamStaff['role']): TeamStaffRow => ({
  id: `ts-${userId}`,
  teamId: 't1',
  userId,
  roleId: role.id,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  user: { id: userId, name, email: `${userId}@example.com` },
  role,
});

const headRow = makeRow('coach-1', 'Frank Vogel', headRole);
const assistantRow = makeRow('asst-1', 'Mike Brown', assistantRole);

const baseTeam: Team = {
  id: 't1',
  name: 'Lakers',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  staff: [headRow, assistantRow],
};

const signIn = (user: { id: string; role: 'PLAYER' | 'COACH' | 'ADMIN'; leagueAdminOf?: string[] }) => {
  useAuthStore.setState({
    user: { ...user, email: 'x@y.z', name: 'X' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('TeamStaffScreen permission gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = baseTeam;
    mockStaff = [headRow, assistantRow];
  });

  it('renders every staff row with name and role for any reader', () => {
    signIn({ id: 'player-1', role: 'PLAYER' });
    const { getByText } = render(<TeamStaffScreen />);
    expect(getByText('Frank Vogel')).toBeTruthy();
    expect(getByText('Mike Brown')).toBeTruthy();
    expect(getByText(/Head Coach · coach-1@example.com/)).toBeTruthy();
    expect(getByText(/Assistant Coach/)).toBeTruthy();
  });

  it('player (not staff): no Add staff, no role change, no remove', () => {
    signIn({ id: 'player-1', role: 'PLAYER' });
    const { queryByText, queryByLabelText } = render(<TeamStaffScreen />);
    expect(queryByText('Add staff')).toBeNull();
    expect(queryByLabelText(/Change role/)).toBeNull();
    expect(queryByLabelText(/^Remove:/)).toBeNull();
    expect(queryByLabelText('Leave team')).toBeNull();
  });

  it('assistant coach: read-only except "Leave team" on own row', () => {
    signIn({ id: 'asst-1', role: 'COACH' });
    const { queryByText, queryByLabelText, getByLabelText, getByText } = render(<TeamStaffScreen />);
    expect(queryByText('Add staff')).toBeNull();
    expect(queryByLabelText(/Change role/)).toBeNull();
    expect(getByLabelText('Leave team')).toBeTruthy();
    expect(queryByLabelText('Remove: Frank Vogel')).toBeNull();
    expect(getByText('Mike Brown (You)')).toBeTruthy();
  });

  it('head coach: Add staff, role change on every row, remove on the assistant only (last head coach)', () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    const { getByText, getByLabelText, queryByLabelText } = render(<TeamStaffScreen />);
    expect(getByText('Add staff')).toBeTruthy();
    expect(getByLabelText('Change role: Frank Vogel')).toBeTruthy();
    expect(getByLabelText('Change role: Mike Brown')).toBeTruthy();
    expect(getByLabelText('Remove: Mike Brown')).toBeTruthy();
    // Sole head coach: neither "Remove" nor "Leave team" on their own row.
    expect(queryByLabelText('Leave team')).toBeNull();
    expect(queryByLabelText('Remove: Frank Vogel')).toBeNull();
    expect(getByText(/Last head coach/)).toBeTruthy();
  });

  it('head coach can leave once another head coach exists', () => {
    mockStaff = [headRow, makeRow('coach-2', 'Second Coach', headRole)];
    signIn({ id: 'coach-1', role: 'COACH' });
    const { getByLabelText, queryByText } = render(<TeamStaffScreen />);
    expect(getByLabelText('Leave team')).toBeTruthy();
    expect(getByLabelText('Remove: Second Coach')).toBeTruthy();
    expect(queryByText(/Last head coach/)).toBeNull();
  });

  it('league admin of the team league (no staff row): full controls', () => {
    signIn({ id: 'la-1', role: 'PLAYER', leagueAdminOf: ['league-1'] });
    const { getByText, getByLabelText } = render(<TeamStaffScreen />);
    expect(getByText('Add staff')).toBeTruthy();
    expect(getByLabelText('Remove: Mike Brown')).toBeTruthy();
  });

  it('admin of a different league: read-only', () => {
    signIn({ id: 'la-2', role: 'COACH', leagueAdminOf: ['league-2'] });
    const { queryByText } = render(<TeamStaffScreen />);
    expect(queryByText('Add staff')).toBeNull();
  });

  it('system ADMIN with no staff row: full controls', () => {
    signIn({ id: 'admin-1', role: 'ADMIN' });
    const { getByText, getByLabelText } = render(<TeamStaffScreen />);
    expect(getByText('Add staff')).toBeTruthy();
    expect(getByLabelText('Change role: Frank Vogel')).toBeTruthy();
  });

  it('Add staff form: validates the email, posts by email + role, and maps a 404 to the "no account" hint', async () => {
    signIn({ id: 'coach-1', role: 'COACH' });
    const { getByText, getByTestId, findByText, queryByText } = render(<TeamStaffScreen />);

    fireEvent.press(getByText('Add staff'));
    const input = getByTestId('staff-email-input');
    const submit = () => fireEvent.press(getByTestId('staff-add-submit'));

    // Invalid email never reaches the API.
    fireEvent.changeText(input, 'not-an-email');
    submit();
    expect(await findByText('Enter a valid email address')).toBeTruthy();
    expect(mockAddStaff.mutateAsync).not.toHaveBeenCalled();

    // 404 → "no account" hint inline.
    mockAddStaff.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('User not found'), { apiError: { status: 404, error: 'User not found' } })
    );
    fireEvent.changeText(input, 'nobody@example.com');
    submit();
    expect(await findByText(/No account with that email/)).toBeTruthy();
    expect(mockAddStaff.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      data: { email: 'nobody@example.com', roleType: 'ASSISTANT_COACH' },
    });
    expect(mockShowToast).not.toHaveBeenCalled();

    // Success → toast, form closes.
    mockAddStaff.mutateAsync.mockResolvedValueOnce(assistantRow);
    fireEvent.press(getByText('Head Coach'));
    fireEvent.changeText(input, 'new@example.com');
    submit();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Staff member added', 'success'));
    expect(mockAddStaff.mutateAsync).toHaveBeenLastCalledWith({
      teamId: 't1',
      data: { email: 'new@example.com', roleType: 'HEAD_COACH' },
    });
    expect(queryByText('Email')).toBeNull();
  });

  it('shows the empty state when the team has no staff', () => {
    mockStaff = [];
    signIn({ id: 'admin-1', role: 'ADMIN' });
    const { getByText } = render(<TeamStaffScreen />);
    expect(getByText('No staff yet')).toBeTruthy();
  });
});
