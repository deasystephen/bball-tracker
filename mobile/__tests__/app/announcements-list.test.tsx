/**
 * Team announcements list: the compose form sits above a FlatList, so the
 * screen dismisses the keyboard through KeyboardDismissView (#1122).
 */

import { Keyboard, TextInput } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

import AnnouncementsScreen from '../../app/teams/[id]/announcements';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamStaff } from '../../hooks/useTeams';
import type { Announcement } from '../../hooks/useAnnouncements';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockAnnouncements: Announcement[] = [];
let mockTeam: Team | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
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
  useInfiniteAnnouncements: () => ({
    data: { announcements: mockAnnouncements },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
  useCreateAnnouncement: () => ({ mutateAsync: jest.fn(), isPending: false }),
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

const team: Team = {
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
      user: { id: 'coach-1', name: 'Frank Vogel', email: 'coach-1@example.com' },
      role: coachRole,
      roleId: coachRole.id,
      teamId: 't1',
      createdAt: '',
      updatedAt: '',
    } as unknown as TeamStaff,
  ],
};

const announcement: Announcement = {
  id: 'a1',
  teamId: 't1',
  authorId: 'coach-1',
  title: 'Practice moved',
  body: 'Practice is at 5pm now.',
  createdAt: '2026-10-01T00:00:00Z',
  author: { id: 'coach-1', name: 'Frank Vogel', isManaged: false, deletedAt: null },
  _count: { replies: 2 },
};

let clock = 1000;
const touch = (pageX: number, pageY: number) => ({
  nativeEvent: { pageX, pageY, timestamp: (clock += 16), touches: [{}] },
});

describe('AnnouncementsScreen keyboard (#1122)', () => {
  let dismiss: jest.SpyInstance;
  let focusedInput: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTeam = team;
    mockAnnouncements = [announcement];
    useAuthStore.setState({
      user: { id: 'coach-1', role: 'COACH', email: 'coach-1@example.com', name: 'Frank Vogel' } as never,
      isAuthenticated: true,
      accessToken: 't',
      refreshToken: null,
      isLoading: false,
    });
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    focusedInput = jest
      .spyOn(TextInput.State, 'currentlyFocusedInput')
      .mockReturnValue({} as unknown as ReturnType<typeof TextInput.State.currentlyFocusedInput>);
  });

  afterEach(() => {
    dismiss.mockRestore();
    focusedInput.mockRestore();
  });

  const openCompose = () => {
    const screen = render(<AnnouncementsScreen />);
    fireEvent.press(screen.getByLabelText('New announcement'));
    return screen;
  };

  it('a tap on an announcement in the list dismisses the keyboard', () => {
    const { getByText } = openCompose();

    fireEvent(getByText('Practice is at 5pm now.'), 'touchStart', touch(100, 500));
    fireEvent(getByText('Practice is at 5pm now.'), 'touchEnd', touch(102, 501));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('a tap on the empty state dismisses the keyboard', () => {
    mockAnnouncements = [];
    const { getByText } = openCompose();

    fireEvent(getByText('No Announcements'), 'touchStart', touch(100, 500));
    fireEvent(getByText('No Announcements'), 'touchEnd', touch(100, 500));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('a tap on a compose field keeps the keyboard, and a card still opens its thread', () => {
    const { getByTestId } = openCompose();

    const onField = touch(100, 150);
    fireEvent(getByTestId('announcement-title-input'), 'touchStart', onField);
    fireEvent(getByTestId('announcements-tap-area'), 'touchStart', onField);
    fireEvent(getByTestId('announcements-tap-area'), 'touchEnd', touch(100, 150));
    expect(dismiss).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('announcement-a1'));
    expect(mockRouter.push).toHaveBeenCalledWith('/teams/t1/announcements/a1');
  });
});
