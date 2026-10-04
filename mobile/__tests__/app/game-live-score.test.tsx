/**
 * Watch Live score (#774): the score is one labelled element with a polite
 * live region, and score updates arriving over the socket are announced on
 * iOS. Loading the game and the first snapshot are not announced.
 */

import { AccessibilityInfo } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import GameLiveScreen from '../../app/games/[id]/live';
import type { Game } from '../../types/game';
import type { UseLiveGameResult } from '../../hooks/useLiveGame';

let mockGame: Game | undefined;
let mockLive: UseLiveGameResult;

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ id: 'g1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('../../hooks/useGames', () => ({
  useGame: () => ({ data: mockGame, isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useLiveGame', () => ({
  useLiveGame: () => mockLive,
}));

const game: Game = {
  id: 'g1',
  teamId: 't1',
  opponent: 'Rivals',
  date: '2026-08-30T18:00:00Z',
  status: 'IN_PROGRESS',
  homeScore: 3,
  awayScore: 0,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  team: {
    id: 't1',
    name: 'Lakers',
    season: { id: 's1', name: '2026', isActive: true, league: { id: 'league-1', name: 'Bay' } },
  },
};

const liveWith = (homeScore: number, awayScore: number): UseLiveGameResult =>
  ({
    status: 'IN_PROGRESS',
    score: { homeScore, awayScore },
    events: [],
    connectionState: 'live',
    error: null,
  }) as unknown as UseLiveGameResult;

describe('GameLiveScreen score accessibility (#774)', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => undefined);
    spy.mockClear();
    mockGame = game;
    mockLive = { ...liveWith(0, 0), status: null } as unknown as UseLiveGameResult;
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it('labels the score as one element with a polite live region', () => {
    render(<GameLiveScreen />);
    const score = screen.getByLabelText('Score: Lakers 3, Rivals 0');
    expect(score.props.accessible).toBe(true);
    expect(score.props.accessibilityLiveRegion).toBe('polite');
    expect(spy).not.toHaveBeenCalled();
  });

  it('announces score updates from the socket, not the first score it shows', () => {
    const { rerender } = render(<GameLiveScreen />);

    // The snapshot agrees with the REST score: nothing to say.
    mockLive = liveWith(3, 0);
    rerender(<GameLiveScreen />);
    expect(spy).not.toHaveBeenCalled();

    mockLive = liveWith(3, 2);
    rerender(<GameLiveScreen />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Score: Lakers 3, Rivals 2', { queue: true });
    expect(screen.getByLabelText('Score: Lakers 3, Rivals 2')).toBeTruthy();
  });

  it('does not announce the game loading in', () => {
    mockGame = undefined;
    const { rerender } = render(<GameLiveScreen />);
    mockGame = game;
    rerender(<GameLiveScreen />);
    expect(spy).not.toHaveBeenCalled();
  });
});
