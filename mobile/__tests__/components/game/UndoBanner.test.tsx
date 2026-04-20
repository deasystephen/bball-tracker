/**
 * Tests for UndoBanner.
 *
 * Covers:
 *   - returns null when not visible (component bails before rendering)
 *   - renders the message + initial countdown when visible
 *   - countdown decrements once per second
 *   - calling onUndo runs when the UNDO button is pressed
 *   - the visible→hidden transition unmounts the banner
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

import { UndoBanner } from '../../../components/game/UndoBanner';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      backgroundTertiary: '#FFF',
      border: '#DDD',
      text: '#111',
      primary: '#06F',
    },
    colorScheme: 'light',
  }),
}));

describe('UndoBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('renders nothing when visible is false', () => {
    const { toJSON } = render(
      <UndoBanner visible={false} message="Removed shot" onUndo={jest.fn()} />
    );
    expect(toJSON()).toBeNull();
  });

  it('renders the message and the initial countdown when visible', () => {
    const { getByText } = render(
      <UndoBanner
        visible
        message="Removed last shot"
        onUndo={jest.fn()}
        duration={5}
      />
    );
    expect(getByText('Removed last shot')).toBeTruthy();
    expect(getByText('UNDO (5s)')).toBeTruthy();
  });

  it('honours a custom duration in the initial countdown label', () => {
    const { getByText } = render(
      <UndoBanner visible message="x" onUndo={jest.fn()} duration={8} />
    );
    expect(getByText('UNDO (8s)')).toBeTruthy();
  });

  it('decrements the countdown every second', () => {
    const { getByText } = render(
      <UndoBanner visible message="x" onUndo={jest.fn()} duration={3} />
    );
    expect(getByText('UNDO (3s)')).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('UNDO (2s)')).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('UNDO (1s)')).toBeTruthy();
  });

  it('calls onUndo when the UNDO button is pressed', () => {
    const onUndo = jest.fn();
    const { getByText } = render(
      <UndoBanner visible message="x" onUndo={onUndo} duration={5} />
    );
    fireEvent.press(getByText('UNDO (5s)'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('unmounts content when toggled from visible to hidden', () => {
    const { rerender, queryByText } = render(
      <UndoBanner visible message="hello" onUndo={jest.fn()} duration={5} />
    );
    expect(queryByText('hello')).toBeTruthy();

    rerender(
      <UndoBanner visible={false} message="hello" onUndo={jest.fn()} duration={5} />
    );
    expect(queryByText('hello')).toBeNull();
  });
});
