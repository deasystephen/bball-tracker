/**
 * "Start next season" (#461): the head coach's entry point on the team screen
 * and the rollover form.
 *
 * Renders the real i18n instance (jest.setup pins expo-localization to `en`).
 * The form prefills the next season's name from the current one, carries the
 * team name and age group (editable; an emptied age group clears it), and
 * replaces itself with the new team-season on success.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import TeamDetailsScreen from '../../app/teams/[id]';
import NextSeasonScreen from '../../app/teams/[id]/next-season';
import { useAuthStore } from '../../store/auth-store';
import type { Team, TeamStaff } from '../../hooks/useTeams';
import { i18n } from '../../i18n';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockRollover = { mutateAsync: jest.fn(), isPending: false, isSuccess: false };
const mockShowToast = jest.fn();
let mockTeam: Team;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
const mockUseAccessGuard = jest.fn((..._args: unknown[]) => true);
jest.mock('../../hooks/useAccessGuard', () => ({ useAccessGuard: (...args: unknown[]) => mockUseAccessGuard(...args) }));
const mockUseSeasons = jest.fn();
let mockSeasonList: {
  seasons: { id: string; name: string; isActive?: boolean; startDate?: string | null; createdAt?: string }[];
  canCreate?: boolean;
};
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeasons: (...args: unknown[]) => {
    mockUseSeasons(...args);
    // Seasons are created after the team's own unless a test says otherwise.
    const data = {
      ...mockSeasonList,
      seasons: mockSeasonList.seasons.map((season) => ({
        isActive: true,
        startDate: null,
        createdAt: '2099-01-01T00:00:00Z',
        ...season,
      })),
    };
    return { data, isLoading: false, error: null, refetch: jest.fn() };
  },
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
  useDeleteTeam: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRolloverTeam: () => mockRollover,
}));

const role = (type: TeamStaff['role']['type']): TeamStaff['role'] => ({
  id: `r-${type}`,
  name: type,
  type,
  canManageTeam: true,
  canManageRoster: true,
  canTrackStats: true,
  canViewStats: true,
  canShareStats: true,
});

function teamWithMyRole(type: TeamStaff['role']['type']): Team {
  return {
    id: 't1',
    name: 'Warriors',
    seasonId: 'se-1',
    lineageId: 'ln-1',
    isLatestInLineage: true,
    ageGroup: 'U12',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    season: {
      id: 'se-1',
      name: '2026',
      isActive: true,
      startDate: null,
      createdAt: '2026-01-01T00:00:00Z',
      league: { id: 'lg-1', name: 'Mine' },
    },
    staff: [{ id: 'st-1', userId: 'coach-1', user: { id: 'coach-1', name: 'Coach', isManaged: false, deletedAt: null }, role: role(type) }],
    members: [],
    invitations: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  mockRollover.isPending = false;
  mockRollover.isSuccess = false;
  mockTeam = teamWithMyRole('HEAD_COACH');
  // A personal league: only the current season so far, and the owner may create.
  mockSeasonList = { seasons: [{ id: 'se-1', name: '2026' }], canCreate: true };
  mockRollover.mutateAsync.mockResolvedValue({
    team: { ...mockTeam, id: 't2', seasonId: 'se-2', season: { id: 'se-2', name: '2027', isActive: true, league: { id: 'lg-1', name: 'Mine' } } },
    created: true,
  });
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'coach@example.com', name: 'Coach' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('team screen entry point', () => {
  it('shows "Start next season" to a head coach and opens the form', () => {
    const { getByText } = render(<TeamDetailsScreen />);

    fireEvent.press(getByText('Start next season'));

    expect(mockRouter.push).toHaveBeenCalledWith('/teams/t1/next-season');
  });

  it("hides it on last season's row: only the latest team-season continues the team", () => {
    mockTeam = { ...teamWithMyRole('HEAD_COACH'), isLatestInLineage: false };

    const { queryByText, getByLabelText } = render(<TeamDetailsScreen />);

    expect(getByLabelText('Edit team')).toBeTruthy();
    expect(queryByText('Start next season')).toBeNull();
  });

  it('hides it when the payload does not say (a backend that predates isLatestInLineage)', () => {
    mockTeam = { ...teamWithMyRole('HEAD_COACH'), isLatestInLineage: undefined };

    const { queryByText } = render(<TeamDetailsScreen />);

    expect(queryByText('Start next season')).toBeNull();
  });

  it('hides it from an assistant coach, who shares the flags but not the head-coach action', () => {
    mockTeam = teamWithMyRole('ASSISTANT_COACH');

    const { queryByText, getByLabelText } = render(<TeamDetailsScreen />);

    // The assistant still manages the team (edit is visible) ...
    expect(getByLabelText('Edit team')).toBeTruthy();
    // ... but cannot roll it over.
    expect(queryByText('Start next season')).toBeNull();
  });
});

describe('NextSeasonScreen', () => {
  it("asks for the league's seasons once the league is known, and offers only the active ones", () => {
    mockSeasonList = {
      seasons: [
        { id: 'se-archived', name: 'Old Fall', isActive: false },
        { id: 'se-next', name: 'Next Fall' },
      ],
      canCreate: false,
    };
    const { queryByTestId, getByTestId } = render(<NextSeasonScreen />);

    expect(mockUseSeasons).toHaveBeenCalledWith({ leagueId: 'lg-1', limit: 100 }, { enabled: true });
    expect(queryByTestId('next-season-option-se-archived')).toBeNull();
    expect(getByTestId('next-season-option-se-next')).toBeTruthy();
  });

  it('does not default to "New season" with a name the league has but hides; it starts on the first offered season', () => {
    // Suggested "2027" exists but is archived; "Fall 2027" is offered.
    mockSeasonList = {
      seasons: [
        { id: 'se-2027', name: '2027', isActive: false },
        { id: 'se-fall', name: 'Fall 2027' },
      ],
      canCreate: true,
    };
    const { getByTestId } = render(<NextSeasonScreen />);

    expect(getByTestId('next-season-option-se-fall').props.accessibilityState).toEqual({ selected: true });
    expect(getByTestId('next-season-option-new').props.accessibilityState).toEqual({ selected: false });
  });

  it('starts on nothing, with submit disabled, when the hidden match leaves nothing offered', () => {
    mockSeasonList = { seasons: [{ id: 'se-2027', name: '2027', isActive: false }], canCreate: true };
    const { getByTestId } = render(<NextSeasonScreen />);

    expect(getByTestId('next-season-option-new').props.accessibilityState).toEqual({ selected: false });
    expect(getByTestId('next-season-submit').props.accessibilityState).toMatchObject({ disabled: true });

    // Choosing "New season" enables it.
    fireEvent.press(getByTestId('next-season-option-new'));
    expect(getByTestId('next-season-submit').props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("never offers the team's own season, even when the list includes it", () => {
    mockSeasonList = {
      seasons: [
        { id: 'se-1', name: '2026' },
        { id: 'se-2', name: '2027' },
      ],
      canCreate: false,
    };
    const { queryByTestId, getByTestId } = render(<NextSeasonScreen />);

    expect(queryByTestId('next-season-option-se-1')).toBeNull();
    expect(getByTestId('next-season-option-se-2')).toBeTruthy();
  });

  it("offers only seasons after the team's own (an older active season is left out)", () => {
    mockTeam = {
      ...teamWithMyRole('HEAD_COACH'),
      season: {
        id: 'se-1',
        name: 'Spring 2025',
        isActive: true,
        startDate: '2025-03-01',
        createdAt: '2025-01-01T00:00:00Z',
        league: { id: 'lg-1', name: 'Club' },
      },
    };
    mockSeasonList = {
      seasons: [
        { id: 'se-old', name: 'Spring 2024', startDate: '2024-03-01' },
        { id: 'se-next', name: 'Spring 2026', startDate: '2026-03-01' },
      ],
      canCreate: false,
    };
    const { queryByTestId, getByTestId } = render(<NextSeasonScreen />);

    expect(queryByTestId('next-season-option-se-old')).toBeNull();
    expect(getByTestId('next-season-option-se-next')).toBeTruthy();
  });

  it('guards a deep link from a caller who cannot manage staff with the not-allowed message', () => {
    mockTeam = { ...teamWithMyRole('HEAD_COACH'), isLatestInLineage: undefined };

    render(<NextSeasonScreen />);

    expect(mockUseAccessGuard).toHaveBeenCalledWith(
      true,
      false,
      'Only a head coach can start the next season.',
      { fallback: '/teams/t1' }
    );
  });

  it('stops guarding once the rollover is in flight or done, so the refetched source cannot bounce the screen', () => {
    // Before submitting, a source that is not the latest is refused.
    mockTeam = { ...teamWithMyRole('HEAD_COACH'), isLatestInLineage: false };
    const screen = render(<NextSeasonScreen />);
    expect(mockUseAccessGuard).toHaveBeenLastCalledWith(true, false, expect.any(String), { fallback: '/teams/t1' });

    // The success path invalidates this team's detail; the refetch says it is
    // no longer the latest. In flight, then succeeded: the guard stays satisfied.
    mockRollover.isPending = true;
    screen.rerender(<NextSeasonScreen />);
    expect(mockUseAccessGuard).toHaveBeenLastCalledWith(true, true, expect.any(String), { fallback: '/teams/t1' });

    mockRollover.isPending = false;
    mockRollover.isSuccess = true;
    screen.rerender(<NextSeasonScreen />);
    expect(mockUseAccessGuard).toHaveBeenLastCalledWith(true, true, expect.any(String), { fallback: '/teams/t1' });
  });

  it("guards a deep link to last season's row with the not-latest message", () => {
    mockTeam = { ...teamWithMyRole('HEAD_COACH'), isLatestInLineage: false };

    render(<NextSeasonScreen />);

    expect(mockUseAccessGuard).toHaveBeenCalledWith(
      true,
      false,
      "Only the team's most recent season can start the next one.",
      { fallback: '/teams/t1' }
    );
  });

  it('offers "New season" with next year prefilled to a coach who may create one, and explains what carries over', () => {
    const { getByTestId, getByText, queryByTestId } = render(<NextSeasonScreen />);

    // The current season is not offered.
    expect(queryByTestId('next-season-option-se-1')).toBeNull();
    expect(getByTestId('next-season-option-new').props.accessibilityState).toEqual({ selected: true });
    expect(getByTestId('next-season-name-input').props.value).toBe('2027');
    expect(getByTestId('next-season-team-name-input').props.value).toBe('Warriors');
    expect(getByTestId('next-season-age-group-input').props.value).toBe('U12');
    expect(
      getByText(
        'Your roster, jersey numbers and staff carry over to the new season. Games, stats and pending invitations stay with 2026.'
      )
    ).toBeTruthy();
  });

  it('sends a new season by name with the edited fields and replaces itself with the new team-season', async () => {
    const { getByTestId, getByText } = render(<NextSeasonScreen />);

    fireEvent.changeText(getByTestId('next-season-age-group-input'), ' U13 ');
    fireEvent.press(getByText('Start season'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/teams/t2'));
    expect(mockRollover.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      data: { seasonName: '2027', name: 'Warriors', ageGroup: 'U13' },
    });
    expect(mockShowToast).toHaveBeenCalledWith('2027 started', 'success');
  });

  it("lets a club coach pick the league's existing season, preselecting the suggested one, and sends its id", async () => {
    mockTeam = {
      ...teamWithMyRole('HEAD_COACH'),
      season: {
        id: 'se-1',
        name: 'Spring 2024',
        isActive: true,
        startDate: null,
        createdAt: '2024-01-01T00:00:00Z',
        league: { id: 'lg-1', name: 'Club' },
      },
    };
    mockSeasonList = {
      seasons: [
        { id: 'se-1', name: 'Spring 2024' },
        { id: 'se-fall', name: 'Fall 2024' },
        { id: 'se-2', name: 'spring 2025' },
      ],
      canCreate: false,
    };
    const { getByTestId, getByText, queryByTestId } = render(<NextSeasonScreen />);

    // No free-text season for a coach who cannot create one.
    expect(queryByTestId('next-season-option-new')).toBeNull();
    expect(queryByTestId('next-season-name-input')).toBeNull();
    // "Spring 2025" is suggested; the league's "spring 2025" matches it.
    expect(getByTestId('next-season-option-se-2').props.accessibilityState).toEqual({ selected: true });

    fireEvent.press(getByText('Fall 2024'));
    expect(getByTestId('next-season-option-se-fall').props.accessibilityState).toEqual({ selected: true });
    fireEvent.press(getByText('Start season'));

    await waitFor(() => expect(mockRollover.mutateAsync).toHaveBeenCalled());
    expect(mockRollover.mutateAsync.mock.calls[0][0]).toEqual({
      teamId: 't1',
      data: { seasonId: 'se-fall', name: 'Warriors', ageGroup: 'U12' },
    });
  });

  it('tells a club coach to ask a league admin when the league has no other season', () => {
    mockSeasonList = { seasons: [{ id: 'se-1', name: '2026' }], canCreate: false };
    const { getByText, getByTestId } = render(<NextSeasonScreen />);

    expect(
      getByText('This league has no other season yet. Ask a league admin to add next season.')
    ).toBeTruthy();
    expect(getByTestId('next-season-submit').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('sends null to clear an emptied age group', async () => {
    const { getByTestId, getByText } = render(<NextSeasonScreen />);

    fireEvent.changeText(getByTestId('next-season-age-group-input'), '');
    fireEvent.press(getByText('Start season'));

    await waitFor(() => expect(mockRollover.mutateAsync).toHaveBeenCalled());
    expect(mockRollover.mutateAsync.mock.calls[0][0].data.ageGroup).toBeNull();
  });

  it('says so when the team already had that season (a repeat is harmless)', async () => {
    mockRollover.mutateAsync.mockResolvedValue({
      team: { ...mockTeam, id: 't2', season: { id: 'se-2', name: '2027', isActive: true, league: { id: 'lg-1', name: 'Mine' } } },
      created: false,
    });
    const { getByText } = render(<NextSeasonScreen />);

    fireEvent.press(getByText('Start season'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('This team already has 2027', 'info'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/teams/t2');
  });

  it('refuses an empty new-season name without calling the API', async () => {
    mockTeam = {
      ...teamWithMyRole('HEAD_COACH'),
      season: { id: 'se-1', name: 'Spring', isActive: true, createdAt: '2026-01-01T00:00:00Z', league: { id: 'lg-1', name: 'Mine' } },
    };
    const { getByTestId, getByText, findByText } = render(<NextSeasonScreen />);

    // No year in "Spring", so nothing is suggested.
    expect(getByTestId('next-season-name-input').props.value).toBe('');
    fireEvent.press(getByText('Start season'));

    expect(await findByText('Enter a name for the new season')).toBeTruthy();
    expect(mockRollover.mutateAsync).not.toHaveBeenCalled();
  });

  /** A refusal as the api-client hands it over: English message, body code, status. */
  const refusal = (status: number, code?: string): Error =>
    Object.assign(new Error('English text from the server'), { apiError: { status, ...(code ? { code } : {}) } });

  it.each([
    ['not_latest_season', refusal(409, 'not_latest_season'), "Only the team's most recent season can start the next one."],
    [
      'team_season_exists',
      refusal(409, 'team_season_exists'),
      "This team already has a team in that season, and you don't manage it. Ask its head coach.",
    ],
    ['season_not_after_source', refusal(400, 'season_not_after_source'), 'Pick a season that starts after this one.'],
    ['season_archived', refusal(409, 'season_archived'), 'That season is archived. Pick an active season or name a new one.'],
    [
      'a 403',
      refusal(403),
      "You can't do that here. A head coach starts the next season, and only a league admin can add a new season.",
    ],
    ['a network failure', new Error('Network Error'), 'Could not start the next season'],
  ])('shows translated copy for %s, never the server English, and stays on the form', async (_label, error, copy) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockRollover.mutateAsync.mockRejectedValue(error);
    const { getByText } = render(<NextSeasonScreen />);

    fireEvent.press(getByText('Start season'));

    await waitFor(() => expect(alert).toHaveBeenCalledWith('Error', copy));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it.each([
    ['not_latest_season', refusal(409, 'not_latest_season'), 'Solo la temporada más reciente del equipo puede empezar la siguiente.'],
    [
      'team_season_exists',
      refusal(409, 'team_season_exists'),
      'Este equipo ya tiene un equipo en esa temporada y tú no lo administras. Pídeselo a su entrenador principal.',
    ],
    ['season_not_after_source', refusal(400, 'season_not_after_source'), 'Elige una temporada que empiece después de esta.'],
    [
      'season_archived',
      refusal(409, 'season_archived'),
      'Esa temporada está archivada. Elige una temporada activa o ponle nombre a una nueva.',
    ],
    [
      'a 403',
      refusal(403),
      'No puedes hacer eso aquí. El entrenador principal empieza la próxima temporada y solo un administrador de la liga puede añadir una temporada nueva.',
    ],
  ])('shows the Spanish copy for %s on a Spanish device', async (_label, error, copy) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockRollover.mutateAsync.mockRejectedValue(error);
    await i18n.changeLanguage('es');
    try {
      const { getByText } = render(<NextSeasonScreen />);
      fireEvent.press(getByText('Empezar temporada'));

      await waitFor(() => expect(alert).toHaveBeenCalledWith('Error', copy));
    } finally {
      await i18n.changeLanguage('en');
      alert.mockRestore();
    }
  });

  it.each([
    ['the header back button', 'Go back'],
    ['Cancel', 'Cancel'],
  ])('%s falls back to the team when there is no history (a deep link)', (_label, target) => {
    mockRouter.canGoBack.mockReturnValue(false);
    const screen = render(<NextSeasonScreen />);

    fireEvent.press(target === 'Go back' ? screen.getByLabelText('Go back') : screen.getByText('Cancel'));

    expect(mockRouter.replace).toHaveBeenCalledWith('/teams/t1');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
