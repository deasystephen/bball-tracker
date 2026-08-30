/**
 * Tests for EventTimeline.
 *
 * Verifies the rendered event descriptions — in particular that a free
 * throw (SHOT with points === 1) reads "FT made"/"FT miss", never
 * "1pt made" — plus the non-shot labels and the empty state.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import { EventTimeline } from '../../../components/game/EventTimeline';
import type { GameEvent, GameEventType } from '../../../types/game';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      text: '#111',
      textSecondary: '#333',
      textTertiary: '#666',
      primary: '#00F',
      success: '#0A0',
      error: '#A00',
      warning: '#FA0',
      info: '#0AF',
      border: '#DDD',
      background: '#FFF',
    },
    colorScheme: 'light',
  }),
}));

let nextId = 0;

const makeEvent = (
  eventType: GameEventType,
  metadata: GameEvent['metadata'],
  playerName = 'LeBron James'
): GameEvent => {
  nextId += 1;
  return {
    id: `event-${nextId}`,
    gameId: 'game-1',
    playerId: `player-${nextId}`,
    eventType,
    timestamp: '2026-08-29T19:00:00.000Z',
    metadata,
    createdAt: '2026-08-29T19:00:00.000Z',
    player: { id: `player-${nextId}`, name: playerName },
  };
};

describe('EventTimeline', () => {
  it('renders a made free throw as "FT made", never "1pt made"', () => {
    const { getByText, queryByText } = render(
      <EventTimeline events={[makeEvent('SHOT', { points: 1, made: true })]} />
    );

    expect(getByText('FT made')).toBeTruthy();
    expect(queryByText('1pt made')).toBeNull();
  });

  it('renders a missed free throw as "FT miss"', () => {
    const { getByText } = render(
      <EventTimeline events={[makeEvent('SHOT', { points: 1, made: false })]} />
    );

    expect(getByText('FT miss')).toBeTruthy();
  });

  it('renders field goals with their point value', () => {
    const { getByText } = render(
      <EventTimeline
        events={[
          makeEvent('SHOT', { points: 2, made: false }),
          makeEvent('SHOT', { points: 3, made: true }),
        ]}
      />
    );

    expect(getByText('2pt miss')).toBeTruthy();
    expect(getByText('3pt made')).toBeTruthy();
  });

  it('renders non-shot events with their labels and the player name', () => {
    const { getByText } = render(
      <EventTimeline
        events={[
          makeEvent('REBOUND', { type: 'offensive' }),
          makeEvent('ASSIST', {}, 'Anthony Davis'),
        ]}
      />
    );

    expect(getByText('Offensive rebound')).toBeTruthy();
    expect(getByText('Assist')).toBeTruthy();
    expect(getByText('Anthony Davis')).toBeTruthy();
  });

  it('renders the empty state when there are no events', () => {
    const { getByText } = render(<EventTimeline events={[]} />);

    expect(getByText('No events yet')).toBeTruthy();
  });
});
