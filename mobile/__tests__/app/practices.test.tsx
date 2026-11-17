/**
 * Practice screens (#33): team schedule, practice detail (availability,
 * guardian answers, the coach's menu with the explicit series choices),
 * create (one-off and recurring) and edit (this one vs all future).
 *
 * Real i18n; the practice and team hooks are replaced at the module boundary
 * so each case states the payload the screen gets.
 */

import { render, fireEvent, act } from '@testing-library/react-native';

import TeamScheduleScreen from '../../app/teams/[id]/schedule';
import PracticeDetailScreen from '../../app/practices/[id]/index';
import CreatePracticeScreen from '../../app/practices/create';
import EditPracticeScreen from '../../app/practices/[id]/edit';
import { useAuthStore } from '../../store/auth-store';
import { deviceTimeZone } from '../../utils/format-date';
import { i18n } from '../../i18n';
import type { Practice, PracticeAvailability, PracticeSeries } from '../../types/practice';
import type { Game } from '../../types/game';
import type { Team, TeamStaff } from '../../hooks/useTeams';
import type { GuardianOfEntry } from '../../../shared/types';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
const mockToast = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockToast }) }));
jest.mock('../../services/api-client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  getApiErrorMessage: (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback),
}));

let mockTeam: Team | undefined;
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
}));

let mockGames: Game[] = [];
jest.mock('../../hooks/useGames', () => ({
  useGames: () => ({ data: mockGames, isLoading: false, error: null, refetch: jest.fn(), isRefetching: false }),
}));

let mockPractice: Practice | undefined;
let mockPractices: Practice[] = [];
let mockAvailability: PracticeAvailability[] = [];
let mockSeries: PracticeSeries | undefined;
const mockSubmit = jest.fn();
const mockCancelOne = jest.fn().mockResolvedValue({});
const mockCancelSeries = jest.fn().mockResolvedValue({ deletedSessions: 7 });
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockCreateOne = jest.fn().mockResolvedValue({ id: 'new' });
const mockCreateSeries = jest.fn().mockResolvedValue({ id: 's-new', sessions: [{}, {}, {}] });
const mockUpdateOne = jest.fn().mockResolvedValue({});
const mockUpdateSeries = jest.fn().mockResolvedValue({ updatedSessions: 4 });
const mutation = (fn: jest.Mock) => ({ mutate: fn, mutateAsync: fn, isPending: false });

jest.mock('../../hooks/usePractices', () => ({
  usePractices: () => ({
    data: { practices: mockPractices, total: mockPractices.length, limit: 200, offset: 0 },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    isRefetching: false,
  }),
  usePractice: () => ({ data: mockPractice, isLoading: false, error: null, refetch: jest.fn() }),
  usePracticeAvailability: () => ({
    data: {
      availability: mockAvailability,
      summary: {
        yes: mockAvailability.filter((a) => a.status === 'YES').length,
        no: mockAvailability.filter((a) => a.status === 'NO').length,
        maybe: mockAvailability.filter((a) => a.status === 'MAYBE').length,
      },
    },
  }),
  usePracticeSeries: () => ({ data: mockSeries, isLoading: false, error: null, refetch: jest.fn() }),
  useSubmitPracticeAvailability: () => mutation(mockSubmit),
  useCancelPractice: () => mutation(mockCancelOne),
  useCancelPracticeSeries: () => mutation(mockCancelSeries),
  useDeletePractice: () => mutation(mockDelete),
  useCreatePractice: () => mutation(mockCreateOne),
  useCreatePracticeSeries: () => mutation(mockCreateSeries),
  useUpdatePractice: () => mutation(mockUpdateOne),
  useUpdatePracticeSeries: () => mutation(mockUpdateSeries),
}));

const coachRole: TeamStaff['role'] = {
  id: 'r1',
  name: 'Head Coach',
  type: 'HEAD_COACH',
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
};

const member = (playerId: string, name: string) => ({
  id: `m-${playerId}`,
  playerId,
  player: { id: playerId, name, isManaged: false, deletedAt: null },
});

const TEAM: Team = {
  id: 't1',
  name: 'Warriors',
  seasonId: 's1',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: { id: 's1', name: '2026', league: { id: 'l1', name: 'Bay' } },
  staff: [
    {
      id: 'st1',
      userId: 'coach',
      user: { id: 'coach', name: 'Steve Kerr', isManaged: false, deletedAt: null },
      role: coachRole,
    },
  ],
  members: [member('steph', 'Steph Curry'), member('seth', 'Seth Curry'), member('klay', 'Klay Thompson')],
};

const SERIES_INFO = {
  id: 'series-1',
  frequency: 'WEEKLY' as const,
  weekdays: [2, 4],
  startTime: '18:00',
  cancelledAt: null,
};

const practice = (extra: Partial<Practice> = {}): Practice => ({
  id: 'p1',
  teamId: 't1',
  seriesId: null,
  type: 'PRACTICE',
  title: 'Shooting',
  location: 'Main gym',
  notes: null,
  startsAt: '2026-12-01T23:00:00Z',
  durationMinutes: 90,
  timezone: 'America/New_York',
  status: 'SCHEDULED',
  cancelledAt: null,
  cancelReason: null,
  isException: false,
  exceptionFields: [],
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  team: { id: 't1', name: 'Warriors' },
  series: null,
  availabilitySummary: { yes: 0, no: 0, maybe: 0 },
  ...extra,
});

const answer = (userId: string, name: string, status: 'YES' | 'NO' | 'MAYBE', comment: string | null = null) => ({
  id: `a-${userId}`,
  sessionId: 'p1',
  userId,
  status,
  comment,
  createdAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  user: { id: userId, name, isManaged: false, deletedAt: null },
});

const signIn = (id: string, guardianOf?: GuardianOfEntry[]) => {
  useAuthStore.setState({
    user: { id, role: 'PLAYER', email: 'x@example.test', name: 'X', guardianOf } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

const child = (childId: string, childName: string): GuardianOfEntry => ({
  childId,
  childName,
  childDeletedAt: null,
  relationship: 'FATHER',
  isPrimary: true,
  isManaged: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTeam = TEAM;
  mockGames = [];
  mockPractices = [];
  mockAvailability = [];
  mockPractice = practice();
  mockSeries = undefined;
});

describe('team schedule', () => {
  beforeEach(() => {
    mockParams = { id: 't1' };
  });

  it('lists games and practices together by start time, marking recurring and cancelled practices', () => {
    signIn('klay');
    mockGames = [
      {
        id: 'g1',
        teamId: 't1',
        opponent: 'Lakers',
        date: '2026-12-02T23:00:00Z',
        status: 'SCHEDULED',
        homeScore: 0,
        awayScore: 0,
        createdAt: '',
        updatedAt: '',
      },
    ];
    mockPractices = [
      practice({ id: 'p1', seriesId: 'series-1', series: SERIES_INFO }),
      practice({ id: 'p2', startsAt: '2026-12-03T23:00:00Z', status: 'CANCELLED', title: null }),
    ];
    const view = render(<TeamScheduleScreen />);
    const ids = view
      .UNSAFE_root.findAll((node) => typeof node.props.testID === 'string' && /^schedule-(game|practice)-/.test(node.props.testID) && typeof node.type !== 'string')
      .map((node) => node.props.testID as string);
    expect([...new Set(ids)]).toEqual(['schedule-practice-p1', 'schedule-game-g1', 'schedule-practice-p2']);
    expect(view.getByLabelText(/^Shooting, .*, Main gym, Repeats$/)).toBeTruthy();
    expect(view.getByLabelText(/^Practice, .*, Main gym, Cancelled$/)).toBeTruthy();
    // A player cannot add practices.
    expect(view.queryByText('Add practice')).toBeNull();
  });

  it('gives a coach "Add practice", which opens the form for this team', () => {
    signIn('coach');
    const view = render(<TeamScheduleScreen />);
    expect(view.getByText('Nothing scheduled')).toBeTruthy();
    fireEvent.press(view.getByText('Add practice'));
    expect(mockRouter.push).toHaveBeenCalledWith('/practices/create?teamId=t1');
  });
});

describe('practice detail: availability', () => {
  beforeEach(() => {
    mockParams = { id: 'p1' };
  });

  it('a rostered player answers for themself in one tap', () => {
    signIn('klay');
    const view = render(<PracticeDetailScreen />);
    expect(view.queryByTestId('practice-responding-for')).toBeNull();
    fireEvent.press(view.getByText('Going'));
    expect(mockSubmit).toHaveBeenCalledWith(
      { practiceId: 'p1', status: 'YES', playerId: undefined },
      expect.anything()
    );
  });

  it('a guardian of two rostered children picks which child, and answers with playerId', () => {
    signIn('dell', [child('steph', 'Steph Curry'), child('seth', 'Seth Curry')]);
    mockAvailability = [answer('seth', 'Seth Curry', 'NO', 'At a tournament')];
    const view = render(<PracticeDetailScreen />);
    expect(view.getByTestId('practice-responding-for')).toBeTruthy();
    expect(view.queryByLabelText('Respond for Me')).toBeNull();

    fireEvent.press(view.getByText('Maybe'));
    expect(mockSubmit).toHaveBeenLastCalledWith(
      { practiceId: 'p1', status: 'MAYBE', playerId: 'steph' },
      expect.anything()
    );

    fireEvent.press(view.getByLabelText('Respond for Seth Curry'));
    // Seth's stored answer and note show for Seth.
    expect(view.getByTestId('practice-answer-NO').props.accessibilityState).toEqual({ selected: true, disabled: false });
    expect(view.getByDisplayValue('At a tournament')).toBeTruthy();
    fireEvent.changeText(view.getByTestId('practice-note-input'), 'Back Thursday');
    fireEvent.press(view.getByTestId('practice-note-save'));
    expect(mockSubmit).toHaveBeenLastCalledWith(
      { practiceId: 'p1', status: 'NO', playerId: 'seth', comment: 'Back Thursday' },
      expect.anything()
    );
  });

  it('a guardian of one child answers for that child without a picker', () => {
    signIn('dell', [child('steph', 'Steph Curry')]);
    const view = render(<PracticeDetailScreen />);
    expect(view.getByText('Answering for Steph Curry')).toBeTruthy();
    fireEvent.press(view.getByText('Going'));
    expect(mockSubmit).toHaveBeenCalledWith(
      { practiceId: 'p1', status: 'YES', playerId: 'steph' },
      expect.anything()
    );
  });

  it('a cancelled practice shows why and takes no answers', () => {
    signIn('klay');
    mockPractice = practice({ status: 'CANCELLED', cancelReason: 'Gym closed', cancelledAt: '2026-11-20T00:00:00Z' });
    const view = render(<PracticeDetailScreen />);
    expect(view.getByText('This practice is cancelled')).toBeTruthy();
    expect(view.getByText('Gym closed')).toBeTruthy();
    expect(view.queryByText('Going')).toBeNull();
  });

  it('shows the time in the session zone and names it for a viewer elsewhere', () => {
    signIn('klay');
    const other = deviceTimeZone() === 'Asia/Tokyo' ? 'Europe/Paris' : 'Asia/Tokyo';
    // 18:00 in either zone.
    const startsAt = other === 'Asia/Tokyo' ? '2026-12-01T09:00:00Z' : '2026-12-01T17:00:00Z';
    mockPractice = practice({ timezone: other, startsAt });
    const view = render(<PracticeDetailScreen />);
    expect(view.getByText(/^6:00\sPM – 7:30\sPM \S+$/)).toBeTruthy();
  });

  it('is Spanish on a Spanish device', async () => {
    signIn('klay');
    await i18n.changeLanguage('es');
    try {
      const view = render(<PracticeDetailScreen />);
      expect(view.getByText('Disponibilidad')).toBeTruthy();
      expect(view.getByText('Tal vez')).toBeTruthy();
      expect(view.queryByText('Availability')).toBeNull();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('practice detail: the coach', () => {
  beforeEach(() => {
    mockParams = { id: 'p1' };
    signIn('coach');
  });

  it('sees the roster breakdown with notes, and answers for nobody', () => {
    mockAvailability = [answer('steph', 'Steph Curry', 'YES'), answer('seth', 'Seth Curry', 'NO', 'Sick')];
    const view = render(<PracticeDetailScreen />);
    expect(view.queryByText('Going')).toBeNull(); // no answer buttons for a coach
    expect(view.getByText('Going (1)')).toBeTruthy();
    expect(view.getByText('Not Going (1)')).toBeTruthy();
    expect(view.getByText('No answer (1)')).toBeTruthy();
    expect(view.getByText('Sick')).toBeTruthy();
  });

  it('a player sees no menu', () => {
    signIn('klay');
    const view = render(<PracticeDetailScreen />);
    expect(view.queryByLabelText('Practice options')).toBeNull();
  });

  it('a series occurrence offers this one and all future, explicitly', () => {
    mockPractice = practice({ seriesId: 'series-1', series: SERIES_INFO });
    const view = render(<PracticeDetailScreen />);
    fireEvent.press(view.getByLabelText('Practice options'));
    for (const label of [
      'Edit this practice',
      'Edit all future practices',
      'Cancel this practice',
      'Cancel all future practices',
      'Delete this practice',
    ]) {
      expect(view.getByText(label)).toBeTruthy();
    }
    fireEvent.press(view.getByText('Edit all future practices'));
    expect(mockRouter.push).toHaveBeenCalledWith('/practices/p1/edit?scope=series');
  });

  it('a standalone practice has no series choices', () => {
    const view = render(<PracticeDetailScreen />);
    fireEvent.press(view.getByLabelText('Practice options'));
    expect(view.getByText('Edit practice')).toBeTruthy();
    expect(view.queryByText('Edit all future practices')).toBeNull();
    expect(view.queryByText('Cancel all future practices')).toBeNull();
  });

  it('cancels one practice with a reason, inline', async () => {
    mockPractice = practice({ seriesId: 'series-1', series: SERIES_INFO });
    const view = render(<PracticeDetailScreen />);
    fireEvent.press(view.getByLabelText('Practice options'));
    fireEvent.press(view.getByText('Cancel this practice'));
    fireEvent.changeText(view.getByTestId('practice-cancel-reason'), 'Gym closed');
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-cancel-confirm'));
    });
    expect(mockCancelOne).toHaveBeenCalledWith({ practiceId: 'p1', reason: 'Gym closed' });
    expect(mockCancelSeries).not.toHaveBeenCalled();
  });

  it('cancels the series only after a second, explicit confirmation, then leaves', async () => {
    mockPractice = practice({ seriesId: 'series-1', series: SERIES_INFO });
    const view = render(<PracticeDetailScreen />);
    fireEvent.press(view.getByLabelText('Practice options'));
    fireEvent.press(view.getByText('Cancel all future practices'));
    expect(mockCancelSeries).not.toHaveBeenCalled();
    expect(view.getByText(/Upcoming practices and their answers are removed/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText('Cancel all future practices'));
    });
    expect(mockCancelSeries).toHaveBeenCalledWith('series-1');
    expect(mockToast).toHaveBeenCalledWith('Series cancelled: 7 upcoming practices removed', 'success');
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('a session of a cancelled series can be deleted but not edited', () => {
    mockPractice = practice({ seriesId: 'series-1', series: { ...SERIES_INFO, cancelledAt: '2026-11-10T00:00:00Z' } });
    const view = render(<PracticeDetailScreen />);
    fireEvent.press(view.getByLabelText('Practice options'));
    expect(view.queryByText('Edit this practice')).toBeNull();
    expect(view.queryByText('Cancel all future practices')).toBeNull();
    expect(view.getByText('Delete this practice')).toBeTruthy();
  });
});

describe('create practice', () => {
  beforeEach(() => {
    mockParams = { teamId: 't1' };
    signIn('coach');
  });

  it('schedules a one-off practice at an instant with the device zone', async () => {
    const view = render(<CreatePracticeScreen />);
    fireEvent.changeText(view.getByTestId('practice-title-input'), ' Shooting ');
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-create-submit'));
    });
    expect(mockCreateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 't1',
        type: 'PRACTICE',
        title: 'Shooting',
        location: undefined,
        durationMinutes: 90,
        timezone: deviceTimeZone(),
        startsAt: expect.stringMatching(/Z$/),
      })
    );
    expect(mockCreateSeries).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith('Practice scheduled', 'success');
  });

  it('schedules a weekly series as local date, wall time, weekdays and zone', async () => {
    const view = render(<CreatePracticeScreen />);
    fireEvent.press(view.getByLabelText('Repeats: Weekly'));
    // Tomorrow's weekday is preselected; add another day.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const extra = (tomorrow.getDay() + 2) % 7;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    fireEvent.press(view.getByLabelText(names[extra]));
    fireEvent.press(view.getByLabelText('Ends: After a number'));
    fireEvent.changeText(view.getByTestId('practice-count-input'), '12');
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-create-submit'));
    });
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(mockCreateSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 't1',
        frequency: 'WEEKLY',
        weekdays: [tomorrow.getDay(), extra].sort((a, b) => a - b),
        startDate: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
        startTime: '18:00',
        occurrenceCount: 12,
        timezone: deviceTimeZone(),
      })
    );
    expect(mockCreateSeries.mock.calls[0][0]).not.toHaveProperty('endDate');
    expect(mockToast).toHaveBeenCalledWith('3 practices scheduled', 'success');
  });

  it('refuses a series with no weekday, before calling the API', async () => {
    const view = render(<CreatePracticeScreen />);
    fireEvent.press(view.getByLabelText('Repeats: Every 2 weeks'));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    fireEvent.press(view.getByLabelText(names[tomorrow.getDay()]));
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-create-submit'));
    });
    expect(view.getByText('Pick at least one day')).toBeTruthy();
    expect(mockCreateSeries).not.toHaveBeenCalled();
  });

  it('turns away a member who cannot manage the team', () => {
    signIn('klay');
    render(<CreatePracticeScreen />);
    expect(mockToast).toHaveBeenCalledWith(
      "You don't have permission to schedule practices for this team.",
      'error'
    );
  });
});

describe('edit practice', () => {
  beforeEach(() => {
    signIn('coach');
  });

  it('"this practice" sends only the fields that changed', async () => {
    mockParams = { id: 'p1', scope: 'one' };
    mockPractice = practice({ seriesId: 'series-1', series: SERIES_INFO });
    const view = render(<EditPracticeScreen />);
    expect(view.getByText(/apply to this practice only/)).toBeTruthy();
    fireEvent.changeText(view.getByTestId('practice-location-input'), 'Gym B');
    fireEvent.press(view.getByLabelText('Duration: 60 min'));
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-edit-save'));
    });
    expect(mockUpdateOne).toHaveBeenCalledWith({ practiceId: 'p1', data: { location: 'Gym B', durationMinutes: 60 } });
  });

  it('"all future" starts from the series, offers no date or time, and patches the series', async () => {
    mockParams = { id: 'p1', scope: 'series' };
    mockPractice = practice({ seriesId: 'series-1', series: SERIES_INFO, title: 'One-off title', isException: true });
    mockSeries = {
      id: 'series-1',
      teamId: 't1',
      type: 'PRACTICE',
      title: 'Shooting',
      location: 'Main gym',
      notes: null,
      frequency: 'WEEKLY',
      weekdays: [2, 4],
      startDate: '2026-11-03',
      startTime: '18:00',
      durationMinutes: 90,
      timezone: 'America/New_York',
      endDate: '2027-02-01',
      occurrenceCount: null,
      cancelledAt: null,
      team: { id: 't1', name: 'Warriors' },
      sessions: [],
    };
    const view = render(<EditPracticeScreen />);
    expect(view.getByDisplayValue('Shooting')).toBeTruthy();
    expect(view.queryByTestId('practice-date-button')).toBeNull();
    expect(view.getByText(/cancel the series and schedule a new one/)).toBeTruthy();
    fireEvent.changeText(view.getByTestId('practice-notes-input'), 'Bring water');
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-edit-save'));
    });
    expect(mockUpdateSeries).toHaveBeenCalledWith({ seriesId: 'series-1', data: { notes: 'Bring water' } });
    expect(mockToast).toHaveBeenCalledWith('Updated 4 upcoming practices', 'success');
  });
});
