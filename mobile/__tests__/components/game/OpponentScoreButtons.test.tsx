/**
 * Tests for OpponentScoreButtons.
 *
 * Verifies the four buttons (-1, +1, +2, +3) call the correct prop with
 * the right argument, that disabling blocks all presses, and that the
 * label is rendered. #773: each is a button named for the opponent score and
 * the delta, at least 44pt tall.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';

import { OpponentScoreButtons } from '../../../components/game/OpponentScoreButtons';

// useTheme — minimal palette covering the keys this component reads.
jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      backgroundSecondary: '#EEE',
      border: '#DDD',
      warning: '#F90',
    },
    colorScheme: 'light',
  }),
}));

describe('OpponentScoreButtons', () => {
  it('renders the section label and all four buttons', () => {
    const { getByText } = render(
      <OpponentScoreButtons onAddPoints={jest.fn()} onSubtractPoint={jest.fn()} />
    );
    expect(getByText('Opponent Score')).toBeTruthy();
    expect(getByText('-1')).toBeTruthy();
    expect(getByText('+1')).toBeTruthy();
    expect(getByText('+2')).toBeTruthy();
    expect(getByText('+3')).toBeTruthy();
  });

  it('calls onSubtractPoint exactly once when -1 is pressed', () => {
    const onSubtractPoint = jest.fn();
    const onAddPoints = jest.fn();
    const { getByText } = render(
      <OpponentScoreButtons
        onAddPoints={onAddPoints}
        onSubtractPoint={onSubtractPoint}
      />
    );

    fireEvent.press(getByText('-1'));

    expect(onSubtractPoint).toHaveBeenCalledTimes(1);
    expect(onAddPoints).not.toHaveBeenCalled();
  });

  it('calls onAddPoints with 1 when +1 is pressed', () => {
    const onAddPoints = jest.fn();
    const { getByText } = render(
      <OpponentScoreButtons
        onAddPoints={onAddPoints}
        onSubtractPoint={jest.fn()}
      />
    );

    fireEvent.press(getByText('+1'));

    expect(onAddPoints).toHaveBeenCalledTimes(1);
    expect(onAddPoints).toHaveBeenCalledWith(1);
  });

  it('calls onAddPoints with 2 when +2 is pressed', () => {
    const onAddPoints = jest.fn();
    const { getByText } = render(
      <OpponentScoreButtons
        onAddPoints={onAddPoints}
        onSubtractPoint={jest.fn()}
      />
    );

    fireEvent.press(getByText('+2'));
    expect(onAddPoints).toHaveBeenCalledWith(2);
  });

  it('calls onAddPoints with 3 when +3 is pressed', () => {
    const onAddPoints = jest.fn();
    const { getByText } = render(
      <OpponentScoreButtons
        onAddPoints={onAddPoints}
        onSubtractPoint={jest.fn()}
      />
    );

    fireEvent.press(getByText('+3'));
    expect(onAddPoints).toHaveBeenCalledWith(3);
  });

  it('does not invoke handlers when disabled', () => {
    const onAddPoints = jest.fn();
    const onSubtractPoint = jest.fn();
    const { getByText } = render(
      <OpponentScoreButtons
        onAddPoints={onAddPoints}
        onSubtractPoint={onSubtractPoint}
        disabled
      />
    );

    fireEvent.press(getByText('-1'));
    fireEvent.press(getByText('+1'));
    fireEvent.press(getByText('+2'));
    fireEvent.press(getByText('+3'));

    expect(onAddPoints).not.toHaveBeenCalled();
    expect(onSubtractPoint).not.toHaveBeenCalled();
  });

  describe('accessibility (#773)', () => {
    it('names each control as a button for the opponent score and its delta', () => {
      const onAddPoints = jest.fn();
      const onSubtractPoint = jest.fn();
      render(<OpponentScoreButtons onAddPoints={onAddPoints} onSubtractPoint={onSubtractPoint} />);

      fireEvent.press(screen.getByRole('button', { name: 'Subtract 1 from opponent score' }));
      expect(onSubtractPoint).toHaveBeenCalledTimes(1);

      for (const points of [1, 2, 3]) {
        fireEvent.press(screen.getByRole('button', { name: `Add ${points} to opponent score` }));
        expect(onAddPoints).toHaveBeenLastCalledWith(points);
      }
      expect(onAddPoints).toHaveBeenCalledTimes(3);
      expect(screen.getAllByRole('button', { name: /opponent score/ })).toHaveLength(4);
    });

    it('makes every control at least 44pt tall', () => {
      render(<OpponentScoreButtons onAddPoints={jest.fn()} onSubtractPoint={jest.fn()} />);

      for (const button of screen.getAllByRole('button', { name: /opponent score/ })) {
        expect(StyleSheet.flatten(button.props.style)).toEqual(
          expect.objectContaining({ minHeight: 44, justifyContent: 'center' })
        );
      }
    });

    it('reports disabled through the accessibility state the disabled prop sets', () => {
      render(<OpponentScoreButtons onAddPoints={jest.fn()} onSubtractPoint={jest.fn()} disabled />);

      for (const button of screen.getAllByRole('button', { name: /opponent score/ })) {
        expect(button).toBeDisabled();
      }
    });
  });
});
