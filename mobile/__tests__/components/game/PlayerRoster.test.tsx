/**
 * Tests for PlayerRoster.
 *
 * Covers:
 *   - empty state when no players
 *   - "Select Player" header + chip rendering when populated
 *   - jersey-number label takes precedence over initials
 *   - initials fallback (uppercase, first two of words) when no jersey
 *   - hot indicator (flame icon) appears only when streak >= 3
 *   - press dispatches onSelectPlayer with (playerId, playerName)
 *   - selected state surfaces via accessibilityState
 *   - selection-only takes the player by playerId, not by member.id
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import { PlayerRoster } from '../../../components/game/PlayerRoster';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      backgroundSecondary: '#EEE',
      border: '#DDD',
      primary: '#06F',
      text: '#111',
      textTertiary: '#999',
    },
    colorScheme: 'light',
  }),
}));

const player = (overrides: {
  id?: string;
  playerId?: string;
  jerseyNumber?: number;
  name: string;
}) => ({
  id: overrides.id ?? `m-${overrides.playerId ?? overrides.name}`,
  playerId: overrides.playerId ?? overrides.name,
  jerseyNumber: overrides.jerseyNumber,
  player: { id: overrides.playerId ?? overrides.name, name: overrides.name },
});

describe('PlayerRoster', () => {
  it('shows the empty state when there are no players', () => {
    const { getByText, queryByText } = render(
      <PlayerRoster
        players={[]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );
    expect(getByText('No players on roster')).toBeTruthy();
    expect(queryByText('Select Player')).toBeNull();
  });

  it('renders the "Select Player" header and a chip per player when populated', () => {
    const { getByText } = render(
      <PlayerRoster
        players={[
          player({ playerId: 'p1', name: 'Alice Adams', jerseyNumber: 7 }),
          player({ playerId: 'p2', name: 'Bob Brown', jerseyNumber: 23 }),
        ]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );
    expect(getByText('Select Player')).toBeTruthy();
    // First-name labels.
    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('Bob')).toBeTruthy();
  });

  it('shows jersey numbers prefixed with #, not initials, when present', () => {
    const { getByText, queryByText } = render(
      <PlayerRoster
        players={[player({ playerId: 'p1', name: 'Alice Adams', jerseyNumber: 7 })]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );
    expect(getByText('#7')).toBeTruthy();
    expect(queryByText('AA')).toBeNull();
  });

  it('falls back to initials (first two, uppercased) when no jersey number', () => {
    const { getByText } = render(
      <PlayerRoster
        players={[player({ playerId: 'p1', name: 'alice adams' })]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );
    expect(getByText('AA')).toBeTruthy();
  });

  it('exposes accessibility label including jersey number when present', () => {
    const { getByLabelText } = render(
      <PlayerRoster
        players={[player({ playerId: 'p1', name: 'Alice Adams', jerseyNumber: 7 })]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );
    expect(getByLabelText('Alice Adams, number 7')).toBeTruthy();
  });

  it('omits jersey portion of accessibility label when no jersey number', () => {
    const { getByLabelText } = render(
      <PlayerRoster
        players={[player({ playerId: 'p1', name: 'Alice Adams' })]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );
    expect(getByLabelText('Alice Adams')).toBeTruthy();
  });

  it('dispatches onSelectPlayer with (playerId, name) when chip is pressed', () => {
    const onSelectPlayer = jest.fn();
    const { getByLabelText } = render(
      <PlayerRoster
        players={[player({ playerId: 'p1', name: 'Alice Adams', jerseyNumber: 7 })]}
        selectedPlayerId={null}
        onSelectPlayer={onSelectPlayer}
      />
    );
    fireEvent.press(getByLabelText('Alice Adams, number 7'));
    expect(onSelectPlayer).toHaveBeenCalledTimes(1);
    expect(onSelectPlayer).toHaveBeenCalledWith('p1', 'Alice Adams');
  });

  it('marks the selected chip via accessibilityState', () => {
    const { getByLabelText } = render(
      <PlayerRoster
        players={[
          player({ playerId: 'p1', name: 'Alice Adams', jerseyNumber: 7 }),
          player({ playerId: 'p2', name: 'Bob Brown', jerseyNumber: 23 }),
        ]}
        selectedPlayerId="p2"
        onSelectPlayer={jest.fn()}
      />
    );
    expect(
      getByLabelText('Alice Adams, number 7').props.accessibilityState
    ).toEqual(expect.objectContaining({ selected: false }));
    expect(
      getByLabelText('Bob Brown, number 23').props.accessibilityState
    ).toEqual(expect.objectContaining({ selected: true }));
  });

  it('marks a player "hot" only when their streak is >= 3', () => {
    const { UNSAFE_getAllByType } = render(
      <PlayerRoster
        players={[
          player({ playerId: 'cold', name: 'Cold Player' }),
          player({ playerId: 'hot', name: 'Hot Player' }),
        ]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
        hotPlayers={{ cold: 2, hot: 3 }}
      />
    );
    // The mocked Ionicons component renders the icon name as text — easy to
    // count flames across the grid.
    const flames = UNSAFE_getAllByType('Text' as unknown as React.ComponentType).filter(
      (node) => node.props.name === 'flame'
    );
    expect(flames).toHaveLength(1);
  });
});
