/**
 * League detail (#614): a season row opens the season screen, and the delete
 * guard matches the API — blocked locally only while some season has teams,
 * confirmed through an ActionMenu otherwise (empty seasons cascade).
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import LeagueDetailScreen, { leagueHasTeams } from '../../app/admin/leagues/[id]';
import type { Season } from '../../hooks/useSeasons';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockDeleteLeague = { mutateAsync: jest.fn(), isPending: false };
let mockSeasons: Season[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'lg-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../hooks/useLeagues', () => ({
  ...jest.requireActual('../../hooks/useLeagues'),
  useLeague: () => ({ data: { id: 'lg-1', name: 'Downtown Youth' }, isLoading: false, error: null, refetch: jest.fn() }),
  useDeleteLeague: () => mockDeleteLeague,
}));
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeasons: () => ({
    data: { success: true, seasons: mockSeasons, total: mockSeasons.length, limit: 50, offset: 0 },
    isLoading: false,
    refetch: jest.fn(),
    isRefetching: false,
  }),
}));

const season = (id: string, teams: number): Season => ({
  id,
  leagueId: 'lg-1',
  name: `Season ${id}`,
  startDate: null,
  endDate: null,
  isActive: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  _count: { teams },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteLeague.mutateAsync.mockResolvedValue(undefined);
  mockSeasons = [season('se-1', 0), season('se-2', 0)];
  useAuthStore.setState({
    user: { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', name: 'Admin' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('LeagueDetailScreen', () => {
  it('opens the season screen from a season row', () => {
    const view = render(<LeagueDetailScreen />);

    fireEvent.press(view.getByTestId('season-row-se-1'));

    expect(mockRouter.push).toHaveBeenCalledWith('/admin/seasons/se-1');
  });

  it('blocks the delete locally only when a season has teams, naming teams', () => {
    mockSeasons = [season('se-1', 0), season('se-2', 3)];
    const view = render(<LeagueDetailScreen />);

    fireEvent.press(view.getByTestId('league-delete-button'));

    expect(mockShowToast).toHaveBeenCalledWith('This league has teams. Remove the teams first.', 'error');
    expect(view.queryByText('Delete Downtown Youth?')).toBeNull();
    expect(mockDeleteLeague.mutateAsync).not.toHaveBeenCalled();
  });

  it('confirms through the action menu and deletes a league whose seasons are empty', async () => {
    const view = render(<LeagueDetailScreen />);

    fireEvent.press(view.getByTestId('league-delete-button'));
    expect(view.getByText('Delete Downtown Youth?')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Delete'));

    await waitFor(() => expect(mockDeleteLeague.mutateAsync).toHaveBeenCalledWith('lg-1'));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith('League deleted', 'success');
  });

  it("shows the server's reason when the delete is refused", async () => {
    mockSeasons = [];
    mockDeleteLeague.mutateAsync.mockRejectedValue(new Error('Cannot delete league with existing teams. Remove teams first.'));
    const view = render(<LeagueDetailScreen />);

    fireEvent.press(view.getByTestId('league-delete-button'));
    fireEvent.press(view.getByLabelText('Delete'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Cannot delete league with existing teams. Remove teams first.', 'error')
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('hides Delete from a league admin who is not a system ADMIN', () => {
    useAuthStore.setState({
      user: { id: 'c-1', role: 'COACH', leagueAdminOf: ['lg-1'], email: 'c@example.com', name: 'Coach' } as never,
    });
    const view = render(<LeagueDetailScreen />);

    expect(view.getByText('Downtown Youth')).toBeTruthy();
    expect(view.queryByTestId('league-delete-button')).toBeNull();
  });
});

describe('leagueHasTeams', () => {
  it('reads _count first, then the teams array, and treats neither as zero', () => {
    expect(leagueHasTeams([])).toBe(false);
    expect(leagueHasTeams([season('a', 0)])).toBe(false);
    expect(leagueHasTeams([season('a', 0), season('b', 1)])).toBe(true);
    expect(leagueHasTeams([{ teams: [{ id: 't', name: 'T' }] }])).toBe(true);
    expect(leagueHasTeams([{}])).toBe(false);
  });
});
