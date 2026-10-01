/**
 * Edit season (#614): the form is seeded from the season, saves only the
 * fields that changed, sends null for a cleared date, and validates like
 * `updateSeasonSchema` plus the service's range check.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import EditSeasonScreen, { buildSeasonPatch } from '../../app/admin/seasons/[id]/edit';
import type { Season } from '../../hooks/useSeasons';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockUpdateSeason = { mutateAsync: jest.fn(), isPending: false };
let mockSeasonQuery: { data?: Season; isLoading: boolean; error: unknown; refetch: jest.Mock };

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
  useUpdateSeason: () => mockUpdateSeason,
}));
jest.mock('@react-native-community/datetimepicker', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => mockReact.createElement(View, props),
  };
});

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
  teams: [],
  _count: { teams: 0 },
};

type View = ReturnType<typeof render>;

const pick = (view: View, buttonId: string, value: Date) => {
  fireEvent.press(view.getByTestId(buttonId));
  fireEvent(view.getByTestId('date-time-picker'), 'onValueChange', { nativeEvent: {} }, value);
  fireEvent.press(view.getByTestId('date-time-picker-done'));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateSeason.mutateAsync.mockResolvedValue(SEASON);
  mockSeasonQuery = { data: SEASON, isLoading: false, error: null, refetch: jest.fn() };
  useAuthStore.setState({
    user: { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', name: 'Admin' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('EditSeasonScreen', () => {
  it('seeds the form from the season', () => {
    const view = render(<EditSeasonScreen />);

    expect(view.getByTestId('season-name-input').props.value).toBe('Spring 2024');
    expect(view.getByLabelText('Start Date: March 1, 2024')).toBeTruthy();
    expect(view.getByLabelText('End Date: June 30, 2024')).toBeTruthy();
    expect(view.getByTestId('season-active-switch').props.value).toBe(true);
  });

  it('saves only the fields that changed', async () => {
    const view = render(<EditSeasonScreen />);

    fireEvent.changeText(view.getByTestId('season-name-input'), ' Spring 2025 ');
    fireEvent(view.getByTestId('season-active-switch'), 'onValueChange', false);
    fireEvent.press(view.getByTestId('season-save-button'));

    await waitFor(() =>
      expect(mockUpdateSeason.mutateAsync).toHaveBeenCalledWith({
        seasonId: 'se-1',
        data: { name: 'Spring 2025', isActive: false },
      })
    );
    expect(mockShowToast).toHaveBeenCalledWith('Season updated', 'success');
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('sends null for a cleared date and an ISO string for a picked one', async () => {
    const view = render(<EditSeasonScreen />);
    const newEnd = new Date(2024, 7, 15, 12, 0, 0);

    fireEvent.press(view.getByTestId('season-start-date-clear'));
    pick(view, 'season-end-date-button', newEnd);
    fireEvent.press(view.getByTestId('season-save-button'));

    await waitFor(() =>
      expect(mockUpdateSeason.mutateAsync).toHaveBeenCalledWith({
        seasonId: 'se-1',
        data: { startDate: null, endDate: newEnd.toISOString() },
      })
    );
  });

  it('goes back without a request when nothing changed', () => {
    const view = render(<EditSeasonScreen />);

    fireEvent.press(view.getByTestId('season-save-button'));

    expect(mockUpdateSeason.mutateAsync).not.toHaveBeenCalled();
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('refuses a name over 100 characters and a start after the end', () => {
    const view = render(<EditSeasonScreen />);

    fireEvent.changeText(view.getByTestId('season-name-input'), 'x'.repeat(101));
    fireEvent.press(view.getByTestId('season-save-button'));
    expect(view.getByText('Season name must be 100 characters or fewer')).toBeTruthy();

    fireEvent.changeText(view.getByTestId('season-name-input'), 'Spring 2024');
    pick(view, 'season-start-date-button', new Date(2024, 11, 1, 12, 0, 0));
    fireEvent.press(view.getByTestId('season-save-button'));
    expect(view.getByText('Start date must be before end date')).toBeTruthy();

    expect(mockUpdateSeason.mutateAsync).not.toHaveBeenCalled();
  });

  it("shows the server's message when the save fails and stays", async () => {
    mockUpdateSeason.mutateAsync.mockRejectedValue(new Error('A season with this name already exists in this league'));
    const view = render(<EditSeasonScreen />);

    fireEvent.changeText(view.getByTestId('season-name-input'), 'Fall 2024');
    fireEvent.press(view.getByTestId('season-save-button'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('A season with this name already exists in this league', 'error')
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('bounces a caller who does not administer the league', async () => {
    useAuthStore.setState({
      user: { id: 'c-1', role: 'COACH', leagueAdminOf: [], email: 'c@example.com', name: 'Coach' } as never,
    });
    const view = render(<EditSeasonScreen />);

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId('season-name-input')).toBeNull();
  });
});

describe('buildSeasonPatch', () => {
  const form = {
    name: SEASON.name,
    startDate: new Date(SEASON.startDate!),
    endDate: new Date(SEASON.endDate!),
    isActive: SEASON.isActive,
  };

  it('is empty when nothing changed', () => {
    expect(buildSeasonPatch(SEASON, form)).toEqual({});
  });

  it('treats a cleared date as null, not as "keep"', () => {
    expect(buildSeasonPatch(SEASON, { ...form, endDate: null })).toEqual({ endDate: null });
  });

  it('does not clear a date that was already unset', () => {
    expect(buildSeasonPatch({ ...SEASON, startDate: null }, { ...form, startDate: null })).toEqual({});
  });
});
