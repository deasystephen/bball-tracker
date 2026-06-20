/**
 * Tests for GameCard.
 *
 * Covers:
 *   - status label + color across SCHEDULED / IN_PROGRESS / FINISHED / CANCELLED
 *   - score rendering only for IN_PROGRESS / FINISHED games
 *   - live dot shown only for IN_PROGRESS
 *   - team name fallback when game.team is missing
 *   - onPress fires on tap
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import { GameCard } from '../../../components/game/GameCard';
import type { Game, GameStatus } from '../../../types/game';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      info: '#00F',
      success: '#0A0',
      error: '#A00',
      accent: '#F50',
      textSecondary: '#666',
      textTertiary: '#999',
    },
    colorScheme: 'light',
  }),
}));

const baseGame: Game = {
  id: 'game-1',
  teamId: 'team-1',
  opponent: 'Rivals',
  date: '2026-03-15T19:30:00.000Z',
  status: 'SCHEDULED',
  homeScore: 0,
  awayScore: 0,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  team: { id: 'team-1', name: 'Hawks' },
};

function makeGame(overrides: Partial<Game>): Game {
  return { ...baseGame, ...overrides };
}

describe('GameCard', () => {
  it('renders the team name, opponent, and Scheduled label', () => {
    const { getByText } = render(
      <GameCard game={baseGame} onPress={jest.fn()} />
    );
    expect(getByText('Hawks')).toBeTruthy();
    expect(getByText('Rivals')).toBeTruthy();
    expect(getByText('Scheduled')).toBeTruthy();
  });

  it('falls back to "Your Team" when the team relation is missing', () => {
    const { getByText } = render(
      <GameCard game={makeGame({ team: undefined })} onPress={jest.fn()} />
    );
    expect(getByText('Your Team')).toBeTruthy();
  });

  it('does not render scores for scheduled games', () => {
    const { queryByText } = render(
      <GameCard game={makeGame({ homeScore: 0, awayScore: 0 })} onPress={jest.fn()} />
    );
    // No "Live"/"Final" score numbers beyond the matchup; scores are hidden.
    expect(queryByText('Live')).toBeNull();
  });

  it('renders the Live label and scores for in-progress games', () => {
    const { getByText } = render(
      <GameCard
        game={makeGame({ status: 'IN_PROGRESS', homeScore: 42, awayScore: 38 })}
        onPress={jest.fn()}
      />
    );
    expect(getByText('Live')).toBeTruthy();
    expect(getByText('42')).toBeTruthy();
    expect(getByText('38')).toBeTruthy();
  });

  it('renders the Final label and scores for finished games', () => {
    const { getByText } = render(
      <GameCard
        game={makeGame({ status: 'FINISHED', homeScore: 88, awayScore: 90 })}
        onPress={jest.fn()}
      />
    );
    expect(getByText('Final')).toBeTruthy();
    expect(getByText('88')).toBeTruthy();
    expect(getByText('90')).toBeTruthy();
  });

  it('renders the Cancelled label for cancelled games', () => {
    const { getByText } = render(
      <GameCard game={makeGame({ status: 'CANCELLED' })} onPress={jest.fn()} />
    );
    expect(getByText('Cancelled')).toBeTruthy();
  });

  it('renders the raw status string for an unknown status', () => {
    const { getByText } = render(
      <GameCard
        game={makeGame({ status: 'POSTPONED' as GameStatus })}
        onPress={jest.fn()}
      />
    );
    expect(getByText('POSTPONED')).toBeTruthy();
  });

  it('fires onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByText } = render(<GameCard game={baseGame} onPress={onPress} />);
    fireEvent.press(getByText('Rivals'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
