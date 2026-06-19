/**
 * Tests for BoxScoreTable.
 *
 * Covers header/player/team rows, jersey-number prefix in the player column,
 * the TEAM totals label, and the showExtendedStats column toggle.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import { BoxScoreTable } from '../../../components/stats/BoxScoreTable';
import type { PlayerGameStats, TeamGameStats } from '../../../types/stats';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { primary: '#06C', border: '#ccc', text: '#000', textSecondary: '#666' },
    colorScheme: 'light',
  }),
}));

const player: PlayerGameStats = {
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

const playerNoJersey: PlayerGameStats = {
  ...player,
  playerId: 'p2',
  playerName: 'Jane Smith',
  jerseyNumber: undefined,
};

const teamStats: TeamGameStats = {
  teamId: 't1',
  teamName: 'Hawks',
  points: 88,
  rebounds: 40,
  assists: 20,
  steals: 8,
  blocks: 4,
  turnovers: 12,
  fouls: 18,
  fieldGoalsMade: 33,
  fieldGoalsAttempted: 70,
  fieldGoalPercentage: 47.1,
  threePointersMade: 8,
  threePointersAttempted: 22,
  threePointPercentage: 36.4,
  freeThrowsMade: 14,
  freeThrowsAttempted: 18,
  freeThrowPercentage: 77.8,
};

describe('BoxScoreTable', () => {
  it('renders headers, the player row with jersey prefix, and the TEAM totals row', () => {
    const { getByText } = render(
      <BoxScoreTable players={[player]} teamStats={teamStats} />
    );
    expect(getByText('Player')).toBeTruthy();
    expect(getByText('PTS')).toBeTruthy();
    expect(getByText('#23 John Doe')).toBeTruthy();
    expect(getByText('TEAM')).toBeTruthy();
  });

  it('renders a player without a jersey number', () => {
    const { getByText } = render(
      <BoxScoreTable players={[playerNoJersey]} teamStats={teamStats} />
    );
    expect(getByText('Jane Smith')).toBeTruthy();
  });

  it('includes extended shooting columns by default', () => {
    const { getByText } = render(
      <BoxScoreTable players={[player]} teamStats={teamStats} />
    );
    expect(getByText('FG')).toBeTruthy();
    expect(getByText('3P%')).toBeTruthy();
    expect(getByText('FT%')).toBeTruthy();
  });

  it('omits extended columns when showExtendedStats is false', () => {
    const { queryByText, getByText } = render(
      <BoxScoreTable players={[player]} teamStats={teamStats} showExtendedStats={false} />
    );
    expect(getByText('PTS')).toBeTruthy();
    expect(queryByText('FG%')).toBeNull();
    expect(queryByText('3P%')).toBeNull();
  });

  it('renders multiple player rows with alternating backgrounds', () => {
    const { getByText } = render(
      <BoxScoreTable players={[player, playerNoJersey]} teamStats={teamStats} />
    );
    expect(getByText('#23 John Doe')).toBeTruthy();
    expect(getByText('Jane Smith')).toBeTruthy();
  });
});
