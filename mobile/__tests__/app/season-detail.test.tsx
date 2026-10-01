/**
 * Season detail (#614): renders the season, opens Edit, confirms Delete through
 * an ActionMenu, surfaces the server's 400 when the season still has teams,
 * and bounces a caller who does not administer the league.
 *
 * The access guard is real; the router, the toast and the season hooks are mocked.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import SeasonDetailScreen, { formatSeasonRange } from '../../app/admin/seasons/[id]';
import type { Season } from '../../hooks/useSeasons';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockDeleteSeason = { mutateAsync: jest.fn(), isPending: false };
let mockSeasonQuery: { data?: Season; isLoading: boolean; error: unknown; refetch: jest.Mock; isRefetching: boolean };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'se-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeason: () => mockSeasonQuery,
  useDeleteSeason: () => mockDeleteSeason,
}));

const SEASON: Season = {
  id: 'se-1',
  leagueId: 'lg-1',
  name: 'Spring 2024',
  startDate: '2024-03-01T12:00:00.000Z',
  endDate: '2024-06-30T12:00:00.000Z',
  isActive: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  league: { id: 'lg-1', name: 'Downtown Youth' },
  teams: [{ id: 't1', name: 'Warriors' }],
  _count: { teams: 1 },
};

const signIn = (user: Record<string, unknown>) =>
  useAuthStore.setState({
    user: { id: 'u-1', email: 'u@example.com', name: 'U', ...user } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  mockDeleteSeason.mutateAsync.mockResolvedValue(undefined);
  mockSeasonQuery = { data: SEASON, isLoading: false, error: null, refetch: jest.fn(), isRefetching: false };
  signIn({ role: 'ADMIN' });
});

describe('SeasonDetailScreen', () => {
  it('renders the season with its league, state, team count and teams', () => {
    const view = render(<SeasonDetailScreen />);

    expect(view.getByText('Spring 2024')).toBeTruthy();
    expect(view.getByText('Downtown Youth')).toBeTruthy();
    expect(view.getByText('Active')).toBeTruthy();
    expect(view.getByText('1 team')).toBeTruthy();
    expect(view.getByText(formatSeasonRange(SEASON, { noStart: 'No start', noEnd: 'No end' })!)).toBeTruthy();

    fireEvent.press(view.getByLabelText('Warriors'));
    expect(mockRouter.push).toHaveBeenCalledWith('/teams/t1');
  });

  it('shows Inactive and the plural count, and opens Edit', () => {
    mockSeasonQuery.data = { ...SEASON, isActive: false, teams: [], _count: { teams: 0 } };
    const view = render(<SeasonDetailScreen />);

    expect(view.getByText('Inactive')).toBeTruthy();
    expect(view.getByText('0 teams')).toBeTruthy();
    expect(view.getByText('No teams yet')).toBeTruthy();

    fireEvent.press(view.getByLabelText('Edit season'));
    expect(mockRouter.push).toHaveBeenCalledWith('/admin/seasons/se-1/edit');
  });

  it('deletes after confirming in the action menu and pops back to the league', async () => {
    const view = render(<SeasonDetailScreen />);

    fireEvent.press(view.getByLabelText('Delete season'));
    expect(view.getByText('Delete Spring 2024?')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Delete'));

    await waitFor(() => expect(mockDeleteSeason.mutateAsync).toHaveBeenCalledWith('se-1'));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith('Season deleted', 'success');
  });

  it('lands on the league after a delete when there is nothing to pop (deep link)', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const view = render(<SeasonDetailScreen />);

    fireEvent.press(view.getByLabelText('Delete season'));
    fireEvent.press(view.getByLabelText('Delete'));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/admin/leagues/lg-1'));
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the season still has teams and stays", async () => {
    const reason = 'Cannot delete season with existing teams. Remove teams first.';
    mockDeleteSeason.mutateAsync.mockRejectedValue(new Error(reason));
    const view = render(<SeasonDetailScreen />);

    fireEvent.press(view.getByLabelText('Delete season'));
    fireEvent.press(view.getByLabelText('Delete'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(reason, 'error'));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(view.getByText('Spring 2024')).toBeTruthy();
  });

  it('lets a league admin edit but not delete (delete is ADMIN-only on the server)', () => {
    signIn({ role: 'COACH', leagueAdminOf: ['lg-1'] });
    const view = render(<SeasonDetailScreen />);

    expect(view.getByLabelText('Edit season')).toBeTruthy();
    expect(view.queryByLabelText('Delete season')).toBeNull();
  });

  it('bounces a caller who does not administer the league', async () => {
    signIn({ role: 'COACH', leagueAdminOf: ['lg-other'] });
    const view = render(<SeasonDetailScreen />);

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(mockShowToast).toHaveBeenCalledWith('Only admins of this league can manage it', 'error');
    expect(view.queryByText('Spring 2024')).toBeNull();
  });

  it('renders ErrorState with a way back when the season cannot be loaded', () => {
    mockSeasonQuery = { data: undefined, isLoading: false, error: new Error('Season not found'), refetch: jest.fn(), isRefetching: false };
    const view = render(<SeasonDetailScreen />);

    expect(view.getByText('Season not found')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Go back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
