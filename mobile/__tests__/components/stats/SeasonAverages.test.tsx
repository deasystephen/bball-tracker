import React from 'react';
import { render } from '@testing-library/react-native';

import { SeasonAverages } from '../../../components/stats/SeasonAverages';
import type {
  AggregatedPlayerStats,
  TeamSeasonStats,
} from '../../../types/stats';

const basePlayerStats: AggregatedPlayerStats = {
  pointsPerGame: 18.5,
  reboundsPerGame: 7.2,
  assistsPerGame: 4.1,
  gamesPlayed: 12,
} as unknown as AggregatedPlayerStats;

describe('SeasonAverages', () => {
  it('renders title and the three averages rounded to one decimal', () => {
    const { getByText } = render(<SeasonAverages stats={basePlayerStats} />);
    expect(getByText('Season Averages')).toBeTruthy();
    expect(getByText('PPG')).toBeTruthy();
    expect(getByText('RPG')).toBeTruthy();
    expect(getByText('APG')).toBeTruthy();
    expect(getByText('18.5')).toBeTruthy();
    expect(getByText('7.2')).toBeTruthy();
    expect(getByText('4.1')).toBeTruthy();
  });

  it('renders pluralized games played for N > 1', () => {
    const { getByText } = render(<SeasonAverages stats={basePlayerStats} />);
    expect(getByText('12 games played')).toBeTruthy();
  });

  it('renders singular games played for N === 1', () => {
    const single = {
      ...basePlayerStats,
      gamesPlayed: 1,
    } as AggregatedPlayerStats;
    const { getByText } = render(<SeasonAverages stats={single} />);
    expect(getByText('1 game played')).toBeTruthy();
  });

  it('omits games played for team stats (no gamesPlayed key)', () => {
    const teamStats = {
      pointsPerGame: 80,
      reboundsPerGame: 40,
      assistsPerGame: 20,
    } as unknown as TeamSeasonStats;
    const { queryByText } = render(<SeasonAverages stats={teamStats} />);
    expect(queryByText(/games played/)).toBeNull();
  });

  it('accepts custom maxValues without crashing', () => {
    const { getByText } = render(
      <SeasonAverages
        stats={basePlayerStats}
        maxValues={{ points: 50, rebounds: 20, assists: 15 }}
      />
    );
    expect(getByText('18.5')).toBeTruthy();
  });
});
