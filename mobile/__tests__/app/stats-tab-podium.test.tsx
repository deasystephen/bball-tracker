/**
 * Stats tab podium (#813): a live player shows by first name; a deleted
 * player shows the whole localized label from `playerDeletedAt`, never the
 * stored English literal and never the first word of the label.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import Stats from '../../app/(tabs)/stats';
import { i18n } from '../../i18n';
import type { AggregatedPlayerStats } from '../../types/stats';

let mockRoster: AggregatedPlayerStats[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../hooks/useStats', () => ({
  ...jest.requireActual('../../hooks/useStats'),
  useTeamSeasonStats: () => ({ data: undefined, isLoading: false, error: null, refetch: jest.fn() }),
  useTeamRosterStats: () => ({ data: mockRoster, isLoading: false, error: null, refetch: jest.fn() }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeams: () => ({ data: [{ id: 'team-1', name: 'Wildcats' }], isLoading: false }),
}));

function row(playerId: string, playerName: string, perGame: { pts: number; reb: number; ast: number }, playerDeletedAt?: string): AggregatedPlayerStats {
  return {
    playerId,
    playerName,
    ...(playerDeletedAt !== undefined && { playerDeletedAt }),
    points: perGame.pts * 2,
    rebounds: perGame.reb * 2,
    offensiveRebounds: 0,
    defensiveRebounds: perGame.reb * 2,
    assists: perGame.ast * 2,
    steals: 0,
    blocks: 0,
    turnovers: 0,
    fouls: 0,
    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    fieldGoalPercentage: 0,
    threePointersMade: 0,
    threePointersAttempted: 0,
    threePointPercentage: 0,
    freeThrowsMade: 0,
    freeThrowsAttempted: 0,
    freeThrowPercentage: 0,
    gamesPlayed: 2,
    pointsPerGame: perGame.pts,
    reboundsPerGame: perGame.reb,
    assistsPerGame: perGame.ast,
    stealsPerGame: 0,
    blocksPerGame: 0,
    turnoversPerGame: 0,
    efficiency: 0,
  };
}

describe('Stats tab podium names', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows a deleted top scorer as the whole localized label and a live player by first name', async () => {
    // Roster rows arrive sorted by points; the tombstone leads scoring, the
    // live player leads rebounds and assists.
    mockRoster = [
      row('gone', 'Deleted user', { pts: 20, reb: 1, ast: 1 }, '2026-09-01T00:00:00.000Z'),
      row('steph', 'Steph Curry', { pts: 10, reb: 8, ast: 6 }),
    ];
    await i18n.changeLanguage('es');
    const { getByText, getAllByText, queryByText } = render(<Stats />);

    expect(getByText('Usuario eliminado')).toBeTruthy();
    expect(getAllByText('Steph')).toHaveLength(2);
    expect(queryByText(/Deleted/)).toBeNull();
    expect(queryByText('Usuario')).toBeNull();
  });
});
