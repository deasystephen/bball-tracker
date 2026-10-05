/**
 * Tests for UndoBanner.
 *
 * Covers:
 *   - returns null when not visible (component bails before rendering)
 *   - renders the message + initial countdown when visible
 *   - countdown decrements once per second
 *   - calling onUndo runs when the UNDO button is pressed
 *   - the visible→hidden transition unmounts the banner
 *   - screen readers hear once that the undo window opened (#774)
 */

import React from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
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

  it('disables UNDO and holds the countdown while pending; starts once confirmed', () => {
    const onUndo = jest.fn();
    const { getByText, queryByText, rerender } = render(
      <UndoBanner visible pending message="x" onUndo={onUndo} duration={3} />
    );
    expect(getByText('SAVING…')).toBeTruthy();
    expect(queryByText('UNDO (3s)')).toBeNull();

    fireEvent.press(getByText('SAVING…'));
    expect(onUndo).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    // Still pending: countdown hasn't moved
    expect(getByText('SAVING…')).toBeTruthy();

    rerender(<UndoBanner visible pending={false} message="x" onUndo={onUndo} duration={3} />);
    expect(getByText('UNDO (3s)')).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(getByText('UNDO (2s)')).toBeTruthy();

    fireEvent.press(getByText('UNDO (2s)'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('restarts the countdown when remounted with a new key (consecutive events)', () => {
    const { getByText, rerender } = render(
      <View><UndoBanner key="e1" visible message="first" onUndo={jest.fn()} duration={5} /></View>
    );
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(getByText('UNDO (2s)')).toBeTruthy();

    rerender(<View><UndoBanner key="e2" visible message="second" onUndo={jest.fn()} duration={5} /></View>);
    expect(getByText('second')).toBeTruthy();
    expect(getByText('UNDO (5s)')).toBeTruthy();
  });

  describe('screen-reader announcement (#774)', () => {
    let spy: jest.SpyInstance;

    beforeEach(() => {
      spy = jest
        .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
        .mockImplementation(() => undefined);
      spy.mockClear();
    });
    afterEach(() => {
      spy.mockRestore();
    });

    it('announces once when the event is confirmed, never per countdown tick', () => {
      const { rerender } = render(
        <UndoBanner visible pending message="Jamie Lee - 2PT Made" onUndo={jest.fn()} duration={5} />
      );
      // Pending: UNDO is not usable yet, so nothing is announced.
      expect(spy).not.toHaveBeenCalled();

      rerender(
        <UndoBanner visible pending={false} message="Jamie Lee - 2PT Made" onUndo={jest.fn()} duration={5} />
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('Jamie Lee - 2PT Made. Undo available for 5 seconds', {
        queue: true,
      });

      act(() => {
        jest.advanceTimersByTime(4000);
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('names the button "Saving" until the event is confirmed, then "Undo"', () => {
      const { getByLabelText, queryByLabelText, rerender } = render(
        <UndoBanner visible pending message="x" onUndo={jest.fn()} duration={5} />
      );
      const saving = getByLabelText('Saving');
      expect(saving.props.accessibilityRole).toBe('button');
      expect(saving.props.accessibilityState).toEqual({ disabled: true });
      expect(queryByLabelText('Undo')).toBeNull();

      rerender(<UndoBanner visible pending={false} message="x" onUndo={jest.fn()} duration={5} />);
      expect(getByLabelText('Undo')).toBeTruthy();
      expect(queryByLabelText('Saving')).toBeNull();
    });

    it('gives the UNDO button a stable name and a button role', () => {
      const { getByLabelText } = render(
        <UndoBanner visible message="x" onUndo={jest.fn()} duration={5} />
      );
      const button = getByLabelText('Undo');
      expect(button.props.accessibilityRole).toBe('button');

      act(() => {
        jest.advanceTimersByTime(2000);
      });
      // The visible countdown moved; the accessible name did not.
      expect(getByLabelText('Undo')).toBeTruthy();
    });

    it('says nothing while hidden', () => {
      render(<UndoBanner visible={false} message="x" onUndo={jest.fn()} />);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('makes the UNDO button a 44pt touch target (#772)', () => {
    const { getByRole } = render(<UndoBanner visible message="x" onUndo={jest.fn()} />);
    expect(StyleSheet.flatten(getByRole('button', { name: 'Undo' }).props.style)).toEqual(
      expect.objectContaining({ minHeight: 44 })
    );
  });
});
