/**
 * Announcement thread screen (#34): renders the announcement and its replies,
 * sends from the inline composer, and offers Delete only to a reply's author
 * or to a coach (`canManageTeam`). The API stays the authority.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';

import AnnouncementThreadScreen from '../../app/teams/[id]/announcements/[announcementId]';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamStaff } from '../../hooks/useTeams';
import type { Announcement } from '../../hooks/useAnnouncements';
import type { AnnouncementReply } from '../../hooks/useAnnouncementReplies';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockCreate = { mutateAsync: jest.fn(), isPending: false };
const mockDelete = { mutateAsync: jest.fn(), isPending: false };
let mockTeam: Team | undefined;
let mockAnnouncement: Announcement | undefined;
let mockReplies: AnnouncementReply[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1', announcementId: 'a1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
  getApiErrorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useAnnouncements', () => ({
  ...jest.requireActual('../../hooks/useAnnouncements'),
  useAnnouncement: () => ({ data: mockAnnouncement, isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useAnnouncementReplies', () => ({
  ...jest.requireActual('../../hooks/useAnnouncementReplies'),
  useInfiniteAnnouncementReplies: () => ({
    data: { replies: mockReplies, total: mockReplies.length },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isRefetching: false,
  }),
  useCreateReply: () => mockCreate,
  useDeleteReply: () => mockDelete,
}));

const coachRole: TeamStaff['role'] = {
  id: 'r-head',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};
const managerRole: TeamStaff['role'] = { ...coachRole, id: 'r-mgr', name: 'Team Manager', type: 'TEAM_MANAGER', canManageTeam: false };

const staffRow = (userId: string, role: TeamStaff['role']): TeamStaff =>
  ({ id: `ts-${userId}`, userId, user: { id: userId, name: userId, email: `${userId}@example.com` }, role, roleId: role.id, teamId: 't1', createdAt: '', updatedAt: '' }) as unknown as TeamStaff;

const team: Team = {
  id: 't1',
  name: 'Lakers',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  staff: [staffRow('coach-1', coachRole), staffRow('manager-1', managerRole)],
};

const announcement: Announcement = {
  id: 'a1',
  teamId: 't1',
  authorId: 'coach-1',
  title: 'Practice moved',
  body: 'Practice is at 5pm now.',
  createdAt: '2026-10-01T00:00:00Z',
  author: { id: 'coach-1', name: 'Frank Vogel' },
  _count: { replies: 2 },
};

const reply = (id: string, authorId: string, name: string, body: string): AnnouncementReply => ({
  id,
  announcementId: 'a1',
  authorId,
  body,
  createdAt: '2026-10-01T01:00:00Z',
  author: { id: authorId, name, profilePictureUrl: null, deletedAt: null },
});

const signIn = (id: string, role: 'PLAYER' | 'COACH' | 'ADMIN' | 'PARENT' = 'PLAYER') => {
  useAuthStore.setState({
    user: { id, role, email: `${id}@example.com`, name: `User ${id}` } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('AnnouncementThreadScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = team;
    mockAnnouncement = announcement;
    mockReplies = [
      reply('r1', 'lebron', 'LeBron James', 'See you there'),
      reply('r2', 'davis', 'Anthony Davis', 'Running late'),
    ];
    mockCreate.mutateAsync.mockResolvedValue(undefined);
    mockDelete.mutateAsync.mockResolvedValue(undefined);
  });

  it('renders the announcement, the reply count and every reply with its author', () => {
    signIn('lebron');
    const { getByText } = render(<AnnouncementThreadScreen />);

    expect(getByText('Practice moved')).toBeTruthy();
    expect(getByText('Practice is at 5pm now.')).toBeTruthy();
    expect(getByText('Frank Vogel')).toBeTruthy();
    expect(getByText('2 replies')).toBeTruthy();
    expect(getByText('LeBron James')).toBeTruthy();
    expect(getByText('See you there')).toBeTruthy();
    expect(getByText('Anthony Davis')).toBeTruthy();
    expect(getByText('Running late')).toBeTruthy();
  });

  it('shows the empty state and a singular count when there are no replies', () => {
    signIn('lebron');
    mockReplies = [];
    const { getByText } = render(<AnnouncementThreadScreen />);

    expect(getByText('0 replies')).toBeTruthy();
    expect(getByText('No replies yet')).toBeTruthy();
  });

  it('sends the trimmed reply with the signed-in author for the optimistic row, then clears the composer', async () => {
    signIn('lebron');
    const { getByTestId } = render(<AnnouncementThreadScreen />);

    const send = getByTestId('reply-send');
    expect(send.props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(getByTestId('reply-input'), '  On my way  ');
    expect(getByTestId('reply-send').props.accessibilityState.disabled).toBe(false);
    fireEvent.press(getByTestId('reply-send'));

    await waitFor(() => expect(mockCreate.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreate.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      announcementId: 'a1',
      body: 'On my way',
      author: { id: 'lebron', name: 'User lebron', profilePictureUrl: null, deletedAt: null },
    });
    expect(getByTestId('reply-input').props.value).toBe('');
  });

  it('hands the text back and toasts when the send fails', async () => {
    signIn('lebron');
    mockCreate.mutateAsync.mockRejectedValueOnce(new Error('Server is down'));
    const { getByTestId } = render(<AnnouncementThreadScreen />);

    fireEvent.changeText(getByTestId('reply-input'), 'On my way');
    fireEvent.press(getByTestId('reply-send'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Server is down', 'error'));
    expect(getByTestId('reply-input').props.value).toBe('On my way');
  });

  it('a player sees the ⋯ menu on their own reply only, and Delete removes it', async () => {
    signIn('lebron');
    const { getAllByLabelText, getByText, queryByText } = render(<AnnouncementThreadScreen />);

    const menus = getAllByLabelText('Reply options');
    expect(menus).toHaveLength(1);

    fireEvent.press(menus[0]);
    expect(getByText('Delete reply')).toBeTruthy();
    fireEvent.press(getByText('Delete reply'));

    await waitFor(() => expect(mockDelete.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockDelete.mutateAsync).toHaveBeenCalledWith({ teamId: 't1', announcementId: 'a1', replyId: 'r1', own: true });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Reply deleted', 'success'));
    expect(queryByText('Delete reply')).toBeNull();
  });

  it('a coach (canManageTeam) sees the menu on every reply and the delete is not "own"', async () => {
    signIn('coach-1', 'COACH');
    const { getAllByLabelText, getByText } = render(<AnnouncementThreadScreen />);

    const menus = getAllByLabelText('Reply options');
    expect(menus).toHaveLength(2);

    fireEvent.press(menus[1]);
    fireEvent.press(getByText('Delete reply'));

    await waitFor(() => expect(mockDelete.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      announcementId: 'a1',
      replyId: 'r2',
      own: false,
    }));
  });

  it('a team manager (no canManageTeam) and a guardian see no menu on others\' replies', () => {
    signIn('manager-1', 'COACH');
    expect(render(<AnnouncementThreadScreen />).queryAllByLabelText('Reply options')).toHaveLength(0);

    signIn('gloria', 'PARENT');
    expect(render(<AnnouncementThreadScreen />).queryAllByLabelText('Reply options')).toHaveLength(0);
  });

  it('a league admin and a system ADMIN can delete any reply', () => {
    useAuthStore.setState({
      user: { id: 'la', role: 'COACH', email: 'la@example.com', name: 'LA', leagueAdminOf: ['league-1'] } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
    expect(render(<AnnouncementThreadScreen />).getAllByLabelText('Reply options')).toHaveLength(2);

    signIn('root', 'ADMIN');
    expect(render(<AnnouncementThreadScreen />).getAllByLabelText('Reply options')).toHaveLength(2);
  });

  it('toasts the server reason when a delete is refused', async () => {
    signIn('lebron');
    mockDelete.mutateAsync.mockRejectedValueOnce(new Error('You do not have permission to delete this reply'));
    const { getAllByLabelText, getByText } = render(<AnnouncementThreadScreen />);

    fireEvent.press(getAllByLabelText('Reply options')[0]);
    fireEvent.press(getByText('Delete reply'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('You do not have permission to delete this reply', 'error')
    );
  });

  it('the header back arrow pops the screen', () => {
    signIn('lebron');
    const { getByLabelText } = render(<AnnouncementThreadScreen />);
    fireEvent.press(getByLabelText('Go back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
