/**
 * Age group + gender on the team create/edit forms (#462).
 *
 * Renders the real i18n instance (jest.setup pins expo-localization to `en`).
 * Create sends the fields only when set; edit prefills them and sends `null`
 * to clear (server rule shared with jersey/position).
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import CreateTeamScreen from '../../app/teams/create';
import EditTeamScreen from '../../app/teams/[id]/edit';
import { useAuthStore } from '../../store/auth-store';
import type { Team } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockCreateTeam = { mutateAsync: jest.fn(), isPending: false };
const mockUpdateTeam = { mutateAsync: jest.fn(), isPending: false };
let mockTeam: Team;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useAccessGuard', () => ({ useAccessGuard: () => true }));
jest.mock('../../hooks/useLeagues', () => ({
  ...jest.requireActual('../../hooks/useLeagues'),
  // Every visible league personal -> name-only create form, no pickers.
  useLeagues: () => ({ data: [{ id: 'lg-p', name: 'Mine', isPersonal: true, createdAt: '', updatedAt: '' }], isLoading: false }),
}));
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeasons: () => ({ data: { seasons: [] }, isLoading: false }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useCreateTeam: () => mockCreateTeam,
  useUpdateTeam: () => mockUpdateTeam,
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateTeam.mutateAsync.mockResolvedValue({ id: 't-new' });
  mockUpdateTeam.mutateAsync.mockResolvedValue({ id: 't1' });
  mockTeam = {
    id: 't1',
    name: 'Warriors',
    seasonId: 'se-p',
    lineageId: 'ln-1',
    ageGroup: 'U14',
    gender: 'BOYS',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    season: { id: 'se-p', name: '2026', isActive: true, league: { id: 'lg-p', name: 'Mine' } },
  };
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'coach@example.com', name: 'Coach' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('CreateTeamScreen — age group & gender', () => {
  it('renders the age-group input and the three gender pills with real copy', () => {
    const { getByText, getByTestId, getByLabelText } = render(<CreateTeamScreen />);

    expect(getByText('Age group')).toBeTruthy();
    expect(getByTestId('team-age-group-input')).toBeTruthy();
    expect(getByLabelText('Gender: Boys')).toBeTruthy();
    expect(getByLabelText('Gender: Girls')).toBeTruthy();
    expect(getByLabelText('Gender: Coed')).toBeTruthy();
  });

  it('submits only the name when neither field is set', async () => {
    const { getByTestId } = render(<CreateTeamScreen />);
    fireEvent.changeText(getByTestId('team-name-input'), 'Warriors');
    fireEvent.press(getByTestId('create-team-submit'));

    await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateTeam.mutateAsync.mock.calls[0][0]).toEqual({ name: 'Warriors' });
  });

  it('submits a trimmed age group and the chosen gender', async () => {
    const { getByTestId, getByLabelText } = render(<CreateTeamScreen />);
    fireEvent.changeText(getByTestId('team-name-input'), 'Warriors');
    fireEvent.changeText(getByTestId('team-age-group-input'), ' U14 ');
    fireEvent.press(getByLabelText('Gender: Girls'));
    fireEvent.press(getByTestId('create-team-submit'));

    await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateTeam.mutateAsync.mock.calls[0][0]).toEqual({ name: 'Warriors', ageGroup: 'U14', gender: 'GIRLS' });
  });

  it('tapping the selected gender pill clears it (gender is optional)', async () => {
    const { getByTestId, getByLabelText } = render(<CreateTeamScreen />);
    fireEvent.changeText(getByTestId('team-name-input'), 'Warriors');
    fireEvent.press(getByLabelText('Gender: Coed'));
    expect(getByLabelText('Gender: Coed').props.accessibilityState).toEqual({ selected: true });
    fireEvent.press(getByLabelText('Gender: Coed'));
    expect(getByLabelText('Gender: Coed').props.accessibilityState).toEqual({ selected: false });
    fireEvent.press(getByTestId('create-team-submit'));

    await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateTeam.mutateAsync.mock.calls[0][0]).toEqual({ name: 'Warriors' });
  });
});

describe('EditTeamScreen — age group & gender', () => {
  it('prefills both fields from the team', () => {
    const { getByTestId, getByLabelText } = render(<EditTeamScreen />);

    expect(getByTestId('team-age-group-input').props.value).toBe('U14');
    expect(getByLabelText('Gender: Boys').props.accessibilityState).toEqual({ selected: true });
  });

  it('sends the edited values', async () => {
    const { getByTestId, getByLabelText, getByText } = render(<EditTeamScreen />);
    fireEvent.changeText(getByTestId('team-age-group-input'), 'U15');
    fireEvent.press(getByLabelText('Gender: Coed'));
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(mockUpdateTeam.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockUpdateTeam.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      data: { name: 'Warriors', seasonId: 'se-p', chatLink: null, ageGroup: 'U15', gender: 'COED' },
    });
  });

  it('sends null to clear an emptied age group and a deselected gender', async () => {
    const { getByTestId, getByLabelText, getByText } = render(<EditTeamScreen />);
    fireEvent.changeText(getByTestId('team-age-group-input'), '   ');
    fireEvent.press(getByLabelText('Gender: Boys'));
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(mockUpdateTeam.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockUpdateTeam.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      data: { name: 'Warriors', seasonId: 'se-p', chatLink: null, ageGroup: null, gender: null },
    });
  });

  it('treats a team from an older backend (no bracket fields) as empty', () => {
    delete mockTeam.ageGroup;
    delete mockTeam.gender;
    const { getByTestId, getByLabelText } = render(<EditTeamScreen />);

    expect(getByTestId('team-age-group-input').props.value).toBe('');
    expect(getByLabelText('Gender: Boys').props.accessibilityState).toEqual({ selected: false });
  });
});
