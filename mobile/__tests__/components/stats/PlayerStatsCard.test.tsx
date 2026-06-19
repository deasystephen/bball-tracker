/**
 * Tests for PlayerStatsCard.
 *
 * Covers:
 *   - per-game stats render (PTS/REB/AST + detailed shooting splits)
 *   - aggregated stats render per-game averages + efficiency when showAverages
 *   - compact mode hides detailed rows
 *   - jersey number / position conditional rendering
 *   - onPress wraps content in a touchable and fires the handler
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import { PlayerStatsCard } from '../../../components/stats/PlayerStatsCard';
import type { PlayerGameStats, AggregatedPlayerStats } from '../../../types/stats';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { textTertiary: '#999', border: '#ccc' },
    colorScheme: 'light',
  }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

const gameStats: PlayerGameStats = {
  playerId: 'p1',
  playerName: 'John Doe',
  jerseyNumber: 23,
  position: 'Guard',
  points: 24,
  rebounds: 8,
  offensiveRebounds: 2,
  defensiveRebounds: 6,
  assists: 5,
  steals: 3,
  blocks: 1,
  turnovers: 2,
  fouls: 4,
  fieldGoalsMade: 9,
  fieldGoalsAttempted: 17,
  fieldGoalPercentage: 52.9,
  threePointersMade: 2,
  threePointersAttempted: 5,
  threePointPercentage: 40,
  freeThrowsMade: 4,
  freeThrowsAttempted: 4,
  freeThrowPercentage: 100,
};

const aggStats: AggregatedPlayerStats = {
  ...gameStats,
  gamesPlayed: 10,
  pointsPerGame: 18.4,
  reboundsPerGame: 7.1,
  assistsPerGame: 4.2,
  stealsPerGame: 1.5,
  blocksPerGame: 0.8,
  turnoversPerGame: 2.0,
  efficiency: 21.3,
};

describe('PlayerStatsCard', () => {
  it('renders player name, jersey number, position and headline stats', () => {
    const { getByText } = render(<PlayerStatsCard stats={gameStats} />);
    expect(getByText('John Doe')).toBeTruthy();
    expect(getByText('#23')).toBeTruthy();
    expect(getByText('Guard')).toBeTruthy();
    expect(getByText('24')).toBeTruthy();
    expect(getByText('PTS')).toBeTruthy();
  });

  it('renders detailed shooting splits in non-compact mode', () => {
    const { getByText } = render(<PlayerStatsCard stats={gameStats} />);
    expect(getByText('9-17')).toBeTruthy();
    expect(getByText('FG (52.9%)')).toBeTruthy();
    expect(getByText('3P (40.0%)')).toBeTruthy();
    expect(getByText('FT (100.0%)')).toBeTruthy();
  });

  it('hides detailed rows in compact mode', () => {
    const { queryByText } = render(<PlayerStatsCard stats={gameStats} compact />);
    expect(queryByText('STL')).toBeNull();
    expect(queryByText('FG (52.9%)')).toBeNull();
  });

  it('omits jersey number and position when not provided', () => {
    const { queryByText } = render(
      <PlayerStatsCard
        stats={{ ...gameStats, jerseyNumber: undefined, position: undefined }}
      />
    );
    expect(queryByText('#23')).toBeNull();
    expect(queryByText('Guard')).toBeNull();
  });

  it('renders per-game averages and efficiency for aggregated stats with showAverages', () => {
    const { getByText } = render(
      <PlayerStatsCard stats={aggStats} showAverages />
    );
    expect(getByText('Total PTS')).toBeTruthy();
    expect(getByText('PPG')).toBeTruthy();
    expect(getByText('18.4')).toBeTruthy();
    expect(getByText('Efficiency: 21.3 | Games: 10')).toBeTruthy();
  });

  it('uses short stat labels when showAverages is false', () => {
    const { getByText, queryByText } = render(
      <PlayerStatsCard stats={aggStats} />
    );
    expect(getByText('PTS')).toBeTruthy();
    expect(queryByText('Total PTS')).toBeNull();
  });

  it('wraps content in a touchable and fires onPress', () => {
    const onPress = jest.fn();
    const { getByText } = render(
      <PlayerStatsCard stats={gameStats} onPress={onPress} />
    );
    fireEvent.press(getByText('John Doe'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
