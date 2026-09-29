/**
 * Pushed screens that fail to load offer a way back (#595).
 *
 * Each of these screens draws its own header and returns `ErrorState` in its
 * place when the data cannot be loaded, so the back arrow goes with it. Found
 * on the player stats screen (#589); these are the other twelve, and that one
 * again for the case it did not cover: a screen opened by a deep link has
 * nothing to pop, and `router.back()` does nothing there.
 *
 * The hooks and the query client are real; only the API is made to fail.
 * `__tests__/a11y/error-state-way-back.test.ts` is the guard that keeps a new
 * screen from bringing the dead end back.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import AdminScreen from '../../app/admin/index';
import LeagueDetailScreen from '../../app/admin/leagues/[id]';
import GameDetailScreen from '../../app/games/[id]/index';
import GameLiveScreen from '../../app/games/[id]/live';
import GameStatsScreen from '../../app/games/[id]/stats';
import TrackGameScreen from '../../app/games/[id]/track';
import PlayerStatsScreen from '../../app/players/[id]/stats';
import TeamDetailScreen from '../../app/teams/[id]';
import EditTeamScreen from '../../app/teams/[id]/edit';
import ManagePlayersScreen from '../../app/teams/[id]/players';
import PlayerGuardiansScreen from '../../app/teams/[id]/players/[playerId]/guardians';
import TeamStaffScreen from '../../app/teams/[id]/staff';
import TeamStatsScreen from '../../app/teams/[id]/stats';
import { apiClient } from '../../services/api-client';
import { useAuthStore } from '../../store/auth-store';

const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};
let mockParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }));
jest.mock('../../services/upload-service', () => ({ uploadAvatar: jest.fn() }));
jest.mock('../../hooks/useLiveGame', () => ({
  useLiveGame: () => ({
    status: null,
    score: { homeScore: 0, awayScore: 0 },
    events: [],
    connectionState: 'connecting',
    error: null,
  }),
}));

const mockGet = apiClient.get as jest.Mock;

interface ScreenCase {
  name: string;
  Screen: React.ComponentType;
  params: Record<string, string>;
  /** Where Go back lands when there is nothing to pop. */
  fallback: string;
}

const SCREENS: ScreenCase[] = [
  { name: 'admin', Screen: AdminScreen, params: {}, fallback: '/(tabs)/profile' },
  { name: 'admin/leagues/[id]', Screen: LeagueDetailScreen, params: { id: 'league-1' }, fallback: '/admin' },
  { name: 'games/[id]', Screen: GameDetailScreen, params: { id: 'g1' }, fallback: '/(tabs)/games' },
  { name: 'games/[id]/live', Screen: GameLiveScreen, params: { id: 'g1' }, fallback: '/(tabs)/games' },
  { name: 'games/[id]/stats', Screen: GameStatsScreen, params: { id: 'g1' }, fallback: '/(tabs)/games' },
  { name: 'games/[id]/track', Screen: TrackGameScreen, params: { id: 'g1' }, fallback: '/(tabs)/games' },
  { name: 'players/[id]/stats', Screen: PlayerStatsScreen, params: { id: 'p1' }, fallback: '/(tabs)/home' },
  { name: 'teams/[id]', Screen: TeamDetailScreen, params: { id: 't1' }, fallback: '/(tabs)/teams' },
  { name: 'teams/[id]/edit', Screen: EditTeamScreen, params: { id: 't1' }, fallback: '/(tabs)/teams' },
  { name: 'teams/[id]/players', Screen: ManagePlayersScreen, params: { id: 't1' }, fallback: '/(tabs)/teams' },
  {
    name: 'teams/[id]/players/[playerId]/guardians',
    Screen: PlayerGuardiansScreen,
    params: { id: 't1', playerId: 'p1' },
    fallback: '/(tabs)/teams',
  },
  { name: 'teams/[id]/staff', Screen: TeamStaffScreen, params: { id: 't1' }, fallback: '/(tabs)/teams' },
  { name: 'teams/[id]/stats', Screen: TeamStatsScreen, params: { id: 't1' }, fallback: '/(tabs)/teams' },
];

function renderScreen(Screen: React.ComponentType): ReturnType<typeof render> {
  // A client per render: nothing cached by one screen reaches the next.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>
  );
}

/** Lets the queries that are still in flight finish inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  mockGet.mockReset();
  // ADMIN passes every permission guard, so the screen gets as far as its error.
  useAuthStore.setState({
    user: { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', name: 'Admin' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
});

describe.each(SCREENS)('$name — when it cannot be loaded', ({ Screen, params, fallback }) => {
  beforeEach(() => {
    mockParams = params;
    mockGet.mockRejectedValue(new Error('The server did not answer'));
  });

  it('shows the reason with Try Again and Go back, and Go back pops the screen', async () => {
    const view = renderScreen(Screen);

    expect(await view.findByText('The server did not answer')).toBeTruthy();
    await settle();
    expect(view.getByLabelText('Try Again')).toBeTruthy();

    fireEvent.press(view.getByLabelText('Go back'));

    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('goes to its parent when there is nothing to pop (opened by a link)', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const view = renderScreen(Screen);
    await view.findByLabelText('Go back');
    await settle();

    fireEvent.press(view.getByLabelText('Go back'));

    expect(mockRouter.replace).toHaveBeenCalledWith(fallback);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('retries on Try Again, and leaves the screen where it is', async () => {
    const view = renderScreen(Screen);
    await view.findByLabelText('Try Again');
    await settle();
    const before = mockGet.mock.calls.length;

    fireEvent.press(view.getByLabelText('Try Again'));
    await settle();

    expect(mockGet.mock.calls.length).toBeGreaterThan(before);
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

describe('games/[id]/track — a game that is not in progress', () => {
  const scheduledGame = {
    id: 'g1',
    teamId: 't1',
    opponent: 'Rivals',
    date: '2026-10-03T18:00:00Z',
    status: 'SCHEDULED',
    homeScore: 0,
    awayScore: 0,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    team: { id: 't1', name: 'Warriors', members: [], staff: [] },
  };

  beforeEach(() => {
    mockParams = { id: 'g1' };
    mockGet.mockImplementation(async (url: string) =>
      url.startsWith('/games/g1/events')
        ? { data: { success: true, events: [] } }
        : { data: { success: true, game: scheduledGame } }
    );
  });

  // The button used to be Try Again, and it left the screen.
  it('offers Go back and no Try Again: there is nothing to retry', async () => {
    const view = renderScreen(TrackGameScreen);

    expect(await view.findByText('This game is not in progress')).toBeTruthy();
    await settle();
    expect(view.queryByLabelText('Try Again')).toBeNull();

    fireEvent.press(view.getByLabelText('Go back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('goes to the game when there is nothing to pop', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const view = renderScreen(TrackGameScreen);
    await view.findByLabelText('Go back');
    await settle();

    fireEvent.press(view.getByLabelText('Go back'));

    expect(mockRouter.replace).toHaveBeenCalledWith('/games/g1');
  });
});
