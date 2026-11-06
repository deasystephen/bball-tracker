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

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockRollover = { mutateAsync: jest.fn(), isPending: false };
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
jest.mock('../../hooks/useAccessGuard', () => ({ useAccessGuard: () => true }));
let mockSeasonList: { seasons: { id: string; name: string }[]; canCreate?: boolean };
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeasons: () => ({ data: mockSeasonList, isLoading: false, error: null, refetch: jest.fn() }),
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
    ageGroup: 'U12',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    season: { id: 'se-1', name: '2026', isActive: true, league: { id: 'lg-1', name: 'Mine' } },
    staff: [{ id: 'st-1', userId: 'coach-1', user: { id: 'coach-1', name: 'Coach', isManaged: false, deletedAt: null }, role: role(type) }],
    members: [],
    invitations: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
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
      season: { id: 'se-1', name: 'Spring 2024', isActive: true, league: { id: 'lg-1', name: 'Club' } },
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
    mockTeam = { ...teamWithMyRole('HEAD_COACH'), season: { id: 'se-1', name: 'Spring', isActive: true, league: { id: 'lg-1', name: 'Mine' } } };
    const { getByTestId, getByText, findByText } = render(<NextSeasonScreen />);

    // No year in "Spring", so nothing is suggested.
    expect(getByTestId('next-season-name-input').props.value).toBe('');
    fireEvent.press(getByText('Start season'));

    expect(await findByText('Enter a name for the new season')).toBeTruthy();
    expect(mockRollover.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the API error in an alert and stays on the form', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockRollover.mutateAsync.mockRejectedValue(new Error('You do not have permission to create seasons for this league'));
    const { getByText } = render(<NextSeasonScreen />);

    fireEvent.press(getByText('Start season'));

    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Error', 'You do not have permission to create seasons for this league')
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
    alert.mockRestore();
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
