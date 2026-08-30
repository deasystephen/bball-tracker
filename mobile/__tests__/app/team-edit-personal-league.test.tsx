/**
 * Edit Team screen — the league/season picker is hidden for a coach whose
 * visible leagues are all personal containers (#442). `team-service.updateTeam`
 * gates a `seasonId` change on `isLeagueAdmin` of the target league, which such
 * a coach never is, so the picker could only ever produce a 403.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import EditTeamScreen from '../../app/teams/[id]/edit';
import { useAuthStore } from '../../store/auth-store';
import type { League } from '../../hooks/useLeagues';
import type { Season } from '../../hooks/useSeasons';
import type { Team } from '../../hooks/useTeams';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockUpdateTeam = { mutateAsync: jest.fn(), isPending: false };
let mockLeagues: League[] = [];
let mockSeasons: Season[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 't1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useAccessGuard', () => ({ useAccessGuard: () => true }));
jest.mock('../../hooks/useLeagues', () => ({
  ...jest.requireActual('../../hooks/useLeagues'),
  useLeagues: () => ({ data: mockLeagues, isLoading: false }),
}));
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeasons: () => ({ data: { seasons: mockSeasons }, isLoading: false }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: mockTeam, isLoading: false, error: null, refetch: jest.fn() }),
  useUpdateTeam: () => mockUpdateTeam,
}));

const mockTeam: Team = {
  id: 't1',
  name: 'Warriors',
  seasonId: 'se-personal',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  season: {
    id: 'se-personal',
    name: '2026',
    isActive: true,
    league: { id: 'lg-personal', name: "Coach's Teams" },
  },
};

const makeLeague = (id: string, name: string, isPersonal?: boolean): League => ({
  id,
  name,
  isPersonal,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
});

const makeSeason = (id: string, leagueId: string, name: string): Season => ({
  id,
  leagueId,
  name,
  isActive: true,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateTeam.mutateAsync.mockResolvedValue({ id: 't1' });
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'coach@example.com', name: 'Coach' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('EditTeamScreen — personal-league branch', () => {
  it('hides the league/season picker when every visible league is personal', () => {
    mockLeagues = [makeLeague('lg-personal', "Coach's Teams", true)];
    mockSeasons = [makeSeason('se-personal', 'lg-personal', '2026')];

    const { queryByText } = render(<EditTeamScreen />);

    expect(queryByText('League')).toBeNull();
    expect(queryByText('Season')).toBeNull();
    expect(queryByText("Coach's Teams")).toBeNull();
    // The removed dead end
    expect(queryByText('No leagues available')).toBeNull();
  });

  it('still saves the team, keeping its existing season', async () => {
    mockLeagues = [makeLeague('lg-personal', "Coach's Teams", true)];
    mockSeasons = [makeSeason('se-personal', 'lg-personal', '2026')];

    const { getByText } = render(<EditTeamScreen />);
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(mockUpdateTeam.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockUpdateTeam.mutateAsync).toHaveBeenCalledWith({
      teamId: 't1',
      data: { name: 'Warriors', seasonId: 'se-personal', chatLink: null },
    });
  });

  it('keeps the picker for a coach who sees a real league', () => {
    mockLeagues = [
      makeLeague('lg-personal', "Coach's Teams", true),
      makeLeague('lg-real', 'Bay Area Youth', false),
    ];
    mockSeasons = [makeSeason('se-personal', 'lg-personal', '2026')];

    const { getByText } = render(<EditTeamScreen />);

    expect(getByText('League')).toBeTruthy();
    expect(getByText('Bay Area Youth')).toBeTruthy();
  });
});
