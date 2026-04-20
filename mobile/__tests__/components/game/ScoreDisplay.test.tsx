/**
 * Tests for ScoreDisplay.
 *
 * Covers:
 *   - team names + numeric scores render
 *   - LIVE badge is shown
 *   - back button is omitted by default and visible when onBack provided
 *   - end button is omitted when showEndButton=false or onEndGame missing
 *   - back/end button presses fire their handlers
 *   - score row exposes a screen-reader-friendly accessibility label
 *   - score updates re-render to the new value
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import { ScoreDisplay } from '../../../components/game/ScoreDisplay';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      success: '#0A0',
      error: '#A00',
    },
    colorScheme: 'light',
  }),
}));

describe('ScoreDisplay', () => {
  const defaultProps = {
    homeTeamName: 'Hawks',
    awayTeamName: 'Bulls',
    homeScore: 10,
    awayScore: 8,
  };

  it('renders both team names and scores', () => {
    const { getByText } = render(<ScoreDisplay {...defaultProps} />);
    expect(getByText('Hawks')).toBeTruthy();
    expect(getByText('Bulls')).toBeTruthy();
    expect(getByText('10')).toBeTruthy();
    expect(getByText('8')).toBeTruthy();
  });

  it('renders the LIVE badge', () => {
    const { getByText } = render(<ScoreDisplay {...defaultProps} />);
    expect(getByText('LIVE')).toBeTruthy();
  });

  it('exposes a combined accessibility label for the score row', () => {
    const { getByLabelText } = render(<ScoreDisplay {...defaultProps} />);
    expect(getByLabelText('Score: Hawks 10, Bulls 8')).toBeTruthy();
  });

  it('does not render the back button when onBack is not provided', () => {
    const { queryByLabelText } = render(<ScoreDisplay {...defaultProps} />);
    expect(queryByLabelText('Go back')).toBeNull();
  });

  it('renders and dispatches the back button when onBack is provided', () => {
    const onBack = jest.fn();
    const { getByLabelText } = render(
      <ScoreDisplay {...defaultProps} onBack={onBack} />
    );
    fireEvent.press(getByLabelText('Go back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders End button when onEndGame is provided and showEndButton is true (default)', () => {
    const onEndGame = jest.fn();
    const { getByLabelText, getByText } = render(
      <ScoreDisplay {...defaultProps} onEndGame={onEndGame} />
    );
    expect(getByText('End')).toBeTruthy();
    fireEvent.press(getByLabelText('End game'));
    expect(onEndGame).toHaveBeenCalledTimes(1);
  });

  it('hides the End button when showEndButton is false even if onEndGame is set', () => {
    const { queryByLabelText, queryByText } = render(
      <ScoreDisplay
        {...defaultProps}
        onEndGame={jest.fn()}
        showEndButton={false}
      />
    );
    expect(queryByLabelText('End game')).toBeNull();
    expect(queryByText('End')).toBeNull();
  });

  it('hides the End button when onEndGame is undefined', () => {
    const { queryByLabelText } = render(
      <ScoreDisplay {...defaultProps} showEndButton />
    );
    expect(queryByLabelText('End game')).toBeNull();
  });

  it('reflects updated scores on rerender', () => {
    const { getByText, rerender, queryByText } = render(
      <ScoreDisplay {...defaultProps} />
    );
    expect(getByText('10')).toBeTruthy();

    rerender(<ScoreDisplay {...defaultProps} homeScore={12} awayScore={11} />);

    expect(queryByText('10')).toBeNull();
    expect(getByText('12')).toBeTruthy();
    expect(getByText('11')).toBeTruthy();
  });
});
