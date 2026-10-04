/**
 * Tests for the Toast provider — concurrent toasts must stack (all visible,
 * in order) instead of overlapping at the same offset (audit #82), and the
 * whole stack must be transparent to touches so it never blocks the nav
 * controls it renders over (#464). Each toast is announced to screen readers
 * once when shown, since it can never take focus (#774).
 */

import React from 'react';
import { AccessibilityInfo, Text, TouchableOpacity } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';

import { ToastProvider, useToast, MAX_VISIBLE_TOASTS } from '../../components/Toast';

function Trigger({ messages }: { messages: string[] }) {
  const { showToast } = useToast();
  return (
    <TouchableOpacity testID="fire" onPress={() => messages.forEach((m) => showToast(m, 'info'))}>
      <Text>fire</Text>
    </TouchableOpacity>
  );
}

describe('ToastProvider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders every concurrent toast in a vertical stack, oldest first', () => {
    const { getByTestId, getAllByTestId, queryByText } = render(
      <ToastProvider>
        <Trigger messages={['Saved', 'Joined team']} />
      </ToastProvider>
    );

    act(() => {
      fireEvent.press(getByTestId('fire'));
    });

    const toasts = getAllByTestId('toast-info');
    expect(toasts).toHaveLength(2);
    expect(queryByText('Saved')).toBeTruthy();
    expect(queryByText('Joined team')).toBeTruthy();
    // Stacking: toasts flow in a column, so none carries its own absolute `top`.
    for (const node of toasts) {
      const flat = Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
      expect(flat.position).not.toBe('absolute');
      expect(flat.top).toBeUndefined();
    }
  });

  it('caps the stack at MAX_VISIBLE_TOASTS by dropping the oldest', () => {
    const messages = ['one', 'two', 'three', 'four', 'five'];
    const { getByTestId, getAllByTestId, queryByText } = render(
      <ToastProvider>
        <Trigger messages={messages} />
      </ToastProvider>
    );

    act(() => {
      fireEvent.press(getByTestId('fire'));
    });

    expect(getAllByTestId('toast-info')).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(queryByText('one')).toBeNull();
    expect(queryByText('five')).toBeTruthy();
  });

  it('toast cards pass touches through (pointerEvents none, #464)', () => {
    // The stack renders over hero back/edit/delete controls; an interactive
    // card swallows taps meant for them for its whole 3s lifetime.
    const { getByTestId, getAllByTestId } = render(
      <ToastProvider>
        <Trigger messages={['Team created successfully']} />
      </ToastProvider>
    );

    act(() => {
      fireEvent.press(getByTestId('fire'));
    });

    for (const node of getAllByTestId('toast-info')) {
      expect(node.props.pointerEvents).toBe('none');
    }
  });

  it('useToast throws outside a provider', () => {
    const Bad = () => {
      useToast();
      return null;
    };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bad />)).toThrow('useToast must be used within a ToastProvider');
    spy.mockRestore();
  });

  it('announces each toast once when shown and keeps it non-interactive (#774)', () => {
    const spy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => undefined);
    spy.mockClear();
    const { getByTestId, getAllByTestId } = render(
      <ToastProvider>
        <Trigger messages={['Failed to record shot', 'Saved']} />
      </ToastProvider>
    );

    act(() => {
      fireEvent.press(getByTestId('fire'));
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 'Failed to record shot', { queue: true });
    expect(spy).toHaveBeenNthCalledWith(2, 'Saved', { queue: true });
    for (const node of getAllByTestId('toast-info')) {
      expect(node.props.pointerEvents).toBe('none');
    }

    // Nothing repeats while the toasts stay up or as they time out.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
