/**
 * Create Season: the optional start and end dates (#576, #583).
 *
 * Each date row is a button that opens the picker sheet, with a clear button
 * beside it once a date is set. The clear button used to sit INSIDE the date
 * button, where VoiceOver cannot reach it.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import CreateSeasonScreen from '../../app/admin/seasons/create';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockCreateSeason = { mutateAsync: jest.fn(), isPending: false };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ leagueId: 'lg-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../hooks/useAccessGuard', () => ({ useAccessGuard: () => true }));
jest.mock('../../hooks/useLeagues', () => ({
  ...jest.requireActual('../../hooks/useLeagues'),
  useLeague: () => ({ data: { id: 'lg-1', name: 'Downtown Youth' }, isLoading: false }),
}));
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useCreateSeason: () => mockCreateSeason,
}));
jest.mock('@react-native-community/datetimepicker', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => mockReact.createElement(View, props),
  };
});

const START = new Date(2027, 2, 6, 12, 0, 0);
const END = new Date(2027, 5, 19, 12, 0, 0);

type View = ReturnType<typeof render>;

const pick = (view: View, buttonId: string, value: Date) => {
  fireEvent.press(view.getByTestId(buttonId));
  fireEvent(view.getByTestId('date-time-picker'), 'onValueChange', { nativeEvent: {} }, value);
  fireEvent.press(view.getByTestId('date-time-picker-done'));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateSeason.mutateAsync.mockResolvedValue({ id: 'se-1' });
  useAuthStore.setState({
    user: { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', name: 'Admin' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe('CreateSeasonScreen — dates', () => {
  it('starts with both dates unset and no clear buttons', () => {
    const view = render(<CreateSeasonScreen />);

    expect(view.getByLabelText('Start Date: Not set')).toBeTruthy();
    expect(view.getByLabelText('End Date: Not set')).toBeTruthy();
    expect(view.queryByTestId('season-start-date-clear')).toBeNull();
    expect(view.queryByTestId('season-end-date-clear')).toBeNull();
  });

  it('sets each date from its own sheet', () => {
    const view = render(<CreateSeasonScreen />);

    fireEvent.press(view.getByTestId('season-start-date-button'));
    expect(view.getByText('Start date')).toBeTruthy();
    fireEvent.press(view.getByTestId('date-time-picker-cancel'));
    expect(view.getByLabelText('Start Date: Not set')).toBeTruthy();

    pick(view, 'season-start-date-button', START);
    pick(view, 'season-end-date-button', END);

    expect(view.getByLabelText('Start Date: March 6, 2027')).toBeTruthy();
    expect(view.getByLabelText('End Date: June 19, 2027')).toBeTruthy();
  });

  it('clears one date without touching the other, and without opening the picker', () => {
    const view = render(<CreateSeasonScreen />);
    pick(view, 'season-start-date-button', START);
    pick(view, 'season-end-date-button', END);

    fireEvent.press(view.getByLabelText('Clear start date'));

    expect(view.getByLabelText('Start Date: Not set')).toBeTruthy();
    expect(view.getByLabelText('End Date: June 19, 2027')).toBeTruthy();
    expect(view.queryByTestId('season-start-date-clear')).toBeNull();
    expect(view.queryByTestId('date-time-picker')).toBeNull();
  });

  it('keeps the clear button outside the date button, with a 44pt target (#583)', () => {
    const view = render(<CreateSeasonScreen />);
    pick(view, 'season-start-date-button', START);

    const clear = view.getByLabelText('Clear start date');
    const enclosing = new Set<string>();
    for (let node = clear.parent; node; node = node.parent) {
      const { accessibilityRole, accessibilityLabel, accessible } = node.props;
      const isAccessible = accessibilityRole === 'button' || accessible === true;
      if (isAccessible && accessibilityLabel !== 'Clear start date') {
        enclosing.add(String(accessibilityLabel ?? '(no label)'));
      }
    }

    expect([...enclosing]).toEqual([]);
    expect(clear).toHaveStyle({ minWidth: 44, minHeight: 44 });
  });

  it('sends the chosen dates, and leaves an unset date out', async () => {
    const view = render(<CreateSeasonScreen />);
    fireEvent.changeText(view.getByPlaceholderText('e.g., Spring 2024, Fall 2024'), 'Spring 2027');
    pick(view, 'season-start-date-button', START);

    // The header carries the same words; the button is the last match.
    const matches = view.getAllByText('Create Season');
    fireEvent.press(matches[matches.length - 1]);

    await waitFor(() => expect(mockCreateSeason.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateSeason.mutateAsync).toHaveBeenCalledWith({
      leagueId: 'lg-1',
      name: 'Spring 2027',
      startDate: START.toISOString(),
      endDate: undefined,
    });
  });
});
