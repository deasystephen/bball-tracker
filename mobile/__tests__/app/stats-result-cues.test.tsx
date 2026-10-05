/**
 * Win / loss / tie never by colour alone (#778).
 *
 * Team Stats showed the season record as two coloured digits, and the Stats
 * tab's streak was a row of empty coloured dots that VoiceOver skipped. Each
 * now carries the result letter. Team Stats reads its record as one sentence;
 * on the Stats tab the pressable card carries the one label for record and
 * streak, so nothing inside it is a second focusable element.
 */

import React from 'react';
import { render, within } from '@testing-library/react-native';

import TeamStatsScreen from '../../app/teams/[id]/stats';
import Stats from '../../app/(tabs)/stats';
import type { TeamSeasonStats } from '../../types/stats';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockSeasonStats: TeamSeasonStats;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'team-1' }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../hooks/useStats', () => ({
  ...jest.requireActual('../../hooks/useStats'),
  useTeamSeasonStats: () => ({ data: mockSeasonStats, isLoading: false, error: null, refetch: jest.fn() }),
  useTeamRosterStats: () => ({ data: [], isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeam: () => ({ data: { id: 'team-1', name: 'Wildcats' }, isLoading: false }),
  useTeams: () => ({ data: [{ id: 'team-1', name: 'Wildcats' }], isLoading: false }),
}));

function game(id: string, result: 'W' | 'L' | 'T') {
  const [homeScore, awayScore] = result === 'W' ? [50, 40] : result === 'L' ? [40, 50] : [45, 45];
  return { id, date: '2026-09-20T18:00:00.000Z', opponent: `Opponent ${id}`, homeScore, awayScore, result };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSeasonStats = {
    teamId: 'team-1',
    teamName: 'Wildcats',
    gamesPlayed: 15,
    trackedGames: 15,
    wins: 7,
    losses: 7,
    ties: 1,
    pointsPerGame: 48,
    reboundsPerGame: 30,
    assistsPerGame: 12,
    turnoversPerGame: 9,
    fieldGoalPercentage: 41.2,
    threePointPercentage: 30.1,
    freeThrowPercentage: 66.6,
    // Most recent first, as the API returns them; ten, so the row's cap of eight shows.
    recentGames: [
      game('g1', 'W'),
      game('g2', 'T'),
      game('g3', 'L'),
      game('g4', 'W'),
      game('g5', 'W'),
      game('g6', 'L'),
      game('g7', 'L'),
      game('g8', 'W'),
      game('g9', 'L'),
      game('g10', 'W'),
    ],
  };
});

describe('Team Stats season record', () => {
  it('puts W, L and T under the numbers and reads the record as one sentence', () => {
    const view = render(<TeamStatsScreen />);
    const record = view.getByTestId('team-stats-record');

    expect(record.props.accessible).toBe(true);
    expect(record.props.accessibilityLabel).toBe('Season record: 7 wins, 7 losses, 1 tie');
    const inRecord = within(record);
    expect(inRecord.getByText('W')).toBeTruthy();
    expect(inRecord.getByText('L')).toBeTruthy();
    expect(inRecord.getByText('T')).toBeTruthy();
  });

  it('leaves ties out of the captions and the label when there are none, and uses the singular', () => {
    mockSeasonStats = { ...mockSeasonStats, wins: 1, losses: 3, ties: 0, gamesPlayed: 4 };
    const view = render(<TeamStatsScreen />);
    const record = view.getByTestId('team-stats-record');

    expect(record.props.accessibilityLabel).toBe('Season record: 1 win, 3 losses');
    expect(within(record).queryByText('T')).toBeNull();
  });
});

describe('Stats tab record card', () => {
  it('carries one label that reads the record and then the last eight results in order', () => {
    const view = render(<Stats />);
    const card = view.getByTestId('stats-record-card');

    expect(card.props.accessibilityLabel).toBe(
      'Wildcats. Season record: 7 wins, 7 losses, 1 tie. ' +
        'Last 8 games, most recent first: win, tie, loss, win, win, loss, loss, win'
    );
  });

  it('adds no second accessible element inside the pressable card', () => {
    const view = render(<Stats />);
    const card = view.getByTestId('stats-record-card');
    const nested = card
      .findAll((node) => node !== card && node.props.accessible === true)
      .map((node) => String(node.props.accessibilityLabel ?? node.type));

    expect(nested).toEqual([]);
  });

  it('prints the letter in every streak dot, so the results survive grayscale', () => {
    const view = render(<Stats />);
    const letters = within(view.getByTestId('stats-streak'))
      .getAllByText(/^[WLT]$/)
      .map((node) => node.props.children);

    expect(letters).toEqual(['W', 'T', 'L', 'W', 'W', 'L', 'L', 'W']);
  });

  it('uses the singular for a single game', () => {
    mockSeasonStats = { ...mockSeasonStats, gamesPlayed: 1, wins: 0, losses: 0, ties: 1, recentGames: [game('g1', 'T')] };
    const view = render(<Stats />);

    expect(view.getByTestId('stats-record-card').props.accessibilityLabel).toBe(
      'Wildcats. Season record: 0 wins, 0 losses, 1 tie. Last game: tie'
    );
  });

  it('leaves the streak out of the label when there are no recent games', () => {
    mockSeasonStats = { ...mockSeasonStats, recentGames: [] };
    const view = render(<Stats />);

    expect(view.queryByTestId('stats-streak')).toBeNull();
    expect(view.getByTestId('stats-record-card').props.accessibilityLabel).toBe(
      'Wildcats. Season record: 7 wins, 7 losses, 1 tie'
    );
  });
});
