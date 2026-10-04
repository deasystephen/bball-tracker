/**
 * ActionMenu: plain items run at once on both platforms; a `waitForClose`
 * item runs only after the sheet has finished closing on iOS (Modal
 * onDismiss, or the fallback timer if that never comes), exactly once, and
 * at once on Android.
 */

import React, { useState } from 'react';
import { Modal, Platform, Text, TouchableOpacity } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ActionMenu, WAIT_FOR_CLOSE_FALLBACK_MS, type ActionMenuItem } from '../../components/ActionMenu';

function Harness({ items }: { items: ActionMenuItem[] }) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <TouchableOpacity testID="open" onPress={() => setVisible(true)}>
        <Text>open</Text>
      </TouchableOpacity>
      <ActionMenu visible={visible} title="Menu" items={items} onClose={() => setVisible(false)} />
    </>
  );
}

const modal = () => screen.UNSAFE_getByType(Modal);
const open = () => fireEvent.press(screen.getByTestId('open'));
const dismissed = () =>
  act(() => {
    modal().props.onDismiss();
  });

describe('ActionMenu', () => {
  let plain: jest.Mock;
  let native: jest.Mock;
  let other: jest.Mock;
  let items: ActionMenuItem[];

  beforeEach(() => {
    jest.useFakeTimers();
    plain = jest.fn();
    native = jest.fn();
    other = jest.fn();
    items = [
      { label: 'Rename', onPress: plain },
      { label: 'Take Photo', waitForClose: true, onPress: native },
      { label: 'Share', waitForClose: true, onPress: other },
    ];
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe.each(['ios', 'android'] as const)('on %s', (os) => {
    beforeEach(() => {
      jest.replaceProperty(Platform, 'OS', os);
    });

    it('runs a plain item at once and closes', () => {
      render(<Harness items={items} />);
      open();
      fireEvent.press(screen.getByLabelText('Rename'));
      expect(plain).toHaveBeenCalledTimes(1);
      expect(modal().props.visible).toBe(false);
    });

    it('Close, the backdrop and Back close without running anything', () => {
      render(<Harness items={items} />);
      open();
      fireEvent.press(screen.getByLabelText('Close'));
      expect(modal().props.visible).toBe(false);
      open();
      fireEvent.press(screen.getByLabelText('Close menu'));
      expect(modal().props.visible).toBe(false);
      open();
      act(() => {
        modal().props.onRequestClose();
      });
      expect(modal().props.visible).toBe(false);
      act(() => {
        jest.advanceTimersByTime(WAIT_FOR_CLOSE_FALLBACK_MS * 2);
      });
      expect(plain).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    });
  });

  describe('a waitForClose item on iOS', () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, 'OS', 'ios');
    });

    it('runs from onDismiss, once, and the fallback never runs it again', () => {
      render(<Harness items={items} />);
      open();
      fireEvent.press(screen.getByLabelText('Take Photo'));
      expect(modal().props.visible).toBe(false);
      expect(native).not.toHaveBeenCalled();

      dismissed();
      expect(native).toHaveBeenCalledTimes(1);

      act(() => {
        jest.advanceTimersByTime(WAIT_FOR_CLOSE_FALLBACK_MS * 2);
      });
      dismissed();
      expect(native).toHaveBeenCalledTimes(1);
    });

    it('runs from the fallback when onDismiss never comes, and a late onDismiss is ignored', () => {
      render(<Harness items={items} />);
      open();
      fireEvent.press(screen.getByLabelText('Take Photo'));

      act(() => {
        jest.advanceTimersByTime(WAIT_FOR_CLOSE_FALLBACK_MS - 1);
      });
      expect(native).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(native).toHaveBeenCalledTimes(1);

      dismissed();
      expect(native).toHaveBeenCalledTimes(1);
    });

    it('a second press replaces the first and its timer', () => {
      render(<Harness items={items} />);
      open();
      // Two quick taps before the sheet re-renders closed.
      const takePhoto = screen.getByLabelText('Take Photo');
      const share = screen.getByLabelText('Share');
      act(() => {
        fireEvent.press(takePhoto);
        fireEvent.press(share);
      });

      dismissed();
      act(() => {
        jest.advanceTimersByTime(WAIT_FOR_CLOSE_FALLBACK_MS * 2);
      });
      expect(native).not.toHaveBeenCalled();
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('reopening the menu before it has closed drops the earlier choice', () => {
      render(<Harness items={items} />);
      open();
      fireEvent.press(screen.getByLabelText('Take Photo'));
      open();

      act(() => {
        jest.advanceTimersByTime(WAIT_FOR_CLOSE_FALLBACK_MS * 2);
      });
      expect(native).not.toHaveBeenCalled();
      expect(modal().props.visible).toBe(true);
    });

    it('unmounting clears the fallback timer', () => {
      const { unmount } = render(<Harness items={items} />);
      open();
      fireEvent.press(screen.getByLabelText('Take Photo'));
      unmount();
      act(() => {
        jest.advanceTimersByTime(WAIT_FOR_CLOSE_FALLBACK_MS * 2);
      });
      expect(native).not.toHaveBeenCalled();
    });
  });

  it('a waitForClose item runs at once on Android', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    render(<Harness items={items} />);
    open();
    fireEvent.press(screen.getByLabelText('Take Photo'));
    expect(native).toHaveBeenCalledTimes(1);
    expect(modal().props.visible).toBe(false);
  });
});
