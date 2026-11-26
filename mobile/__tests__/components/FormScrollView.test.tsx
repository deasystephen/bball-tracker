/**
 * FormScrollView dismisses the keyboard on a tap that is not on a text input
 * (#1118), from the raw touch events: it does not depend on the JS responder
 * system, which left the keyboard up on a device.
 */

import React from 'react';
import { Keyboard, ScrollView, Text, TextInput, TouchableOpacity } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import {
  FormScrollView,
  STUCK_CHECK_MS,
  TAP_SLOP,
  resetStuckKeyboardReport,
} from '../../components/FormScrollView';
import { Input } from '../../components/Input';
import { captureException } from '../../services/sentry';

jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));

let clock = 1000;
/** Every native touch event has its own timestamp; a bubbling one keeps it. */
const touch = (pageX: number, pageY: number, touches = 1) => ({
  nativeEvent: { pageX, pageY, timestamp: (clock += 16), touches: Array.from({ length: touches }, () => ({})) },
});

describe('FormScrollView', () => {
  let dismiss: jest.SpyInstance;
  let focusedInput: jest.SpyInstance;
  let keyboardVisible: jest.SpyInstance;
  const FOCUSED = { field: 'age group' } as unknown as ReturnType<typeof TextInput.State.currentlyFocusedInput>;

  beforeEach(() => {
    jest.useFakeTimers();
    resetStuckKeyboardReport();
    (captureException as jest.Mock).mockClear();
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    keyboardVisible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    // An input has the focus unless a test says otherwise.
    focusedInput = jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(FOCUSED);
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    dismiss.mockRestore();
    focusedInput.mockRestore();
    keyboardVisible.mockRestore();
  });

  const renderForm = () =>
    render(
      <FormScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>Gender</Text>
        <Input label="Age group" testID="age-group" />
        <TouchableOpacity onPress={jest.fn()} accessibilityRole="button">
          <Text>Boys</Text>
        </TouchableOpacity>
      </FormScrollView>
    );

  it('dismisses the keyboard on a tap on a label', () => {
    const { getByText } = renderForm();

    fireEvent(getByText('Gender'), 'touchStart', touch(100, 300));
    fireEvent(getByText('Gender'), 'touchEnd', touch(103, 296));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('needs no responder: it sets none, so nothing can take the tap away from it', () => {
    const area = renderForm().getByTestId('form-scroll-tap-area');

    expect(area.props.onStartShouldSetResponder).toBeUndefined();
    expect(area.props.onResponderRelease).toBeUndefined();
  });

  it('does not dismiss on a cancelled touch: the scroll view or a swipe back took it over', () => {
    const { getByText } = renderForm();

    fireEvent(getByText('Gender'), 'touchStart', touch(100, 300));
    fireEvent(getByText('Gender'), 'touchCancel', touch(100, 306));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss on a drag, whether it ends or is cancelled by the scroll view', () => {
    const { getByText } = renderForm();
    const label = getByText('Gender');

    fireEvent(label, 'touchStart', touch(100, 300));
    fireEvent(label, 'touchMove', touch(100, 300 - TAP_SLOP - 1));
    fireEvent(label, 'touchCancel', touch(100, 300 - TAP_SLOP - 1));

    fireEvent(label, 'touchStart', touch(100, 300));
    fireEvent(label, 'touchEnd', touch(100, 300 + TAP_SLOP + 1));

    // Out and back is still a drag.
    fireEvent(label, 'touchStart', touch(100, 300));
    fireEvent(label, 'touchMove', touch(100, 300 + TAP_SLOP + 5));
    fireEvent(label, 'touchEnd', touch(100, 300));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('leaves a tap on a text input alone: it moves the focus or the cursor', () => {
    const { getByTestId } = renderForm();
    const area = getByTestId('form-scroll-tap-area');

    // fireEvent calls one handler; on a device the same event bubbles from
    // the field (which marks it) to the tap area. Device-only: the order.
    const start = touch(100, 200);
    fireEvent(getByTestId('age-group'), 'touchStart', start);
    fireEvent(area, 'touchStart', start);
    fireEvent(area, 'touchEnd', touch(100, 200));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not carry the mark of a field touch over to the next touch', () => {
    const { getByTestId } = renderForm();
    const area = getByTestId('form-scroll-tap-area');

    // A field outside any FormScrollView was touched: nobody took the mark.
    fireEvent(getByTestId('age-group'), 'touchStart', touch(100, 200));
    fireEvent(area, 'touchStart', touch(100, 300));
    fireEvent(area, 'touchEnd', touch(100, 300));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('treats a read-only field as plain content', () => {
    const { getByTestId } = render(
      <FormScrollView>
        <Input label="Note" testID="note" editable={false} />
      </FormScrollView>
    );
    const area = getByTestId('form-scroll-tap-area');

    const start = touch(100, 200);
    fireEvent(getByTestId('note'), 'touchStart', start);
    fireEvent(area, 'touchStart', start);
    fireEvent(area, 'touchEnd', touch(100, 200));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a tap on a button and still presses it', () => {
    const onPress = jest.fn();
    const { getByText, getByTestId } = render(
      <FormScrollView>
        <TouchableOpacity onPress={onPress} accessibilityRole="button">
          <Text>Save</Text>
        </TouchableOpacity>
      </FormScrollView>
    );

    // The touch events bubble from the button to the tap area on a device.
    fireEvent(getByTestId('form-scroll-tap-area'), 'touchStart', touch(100, 300));
    fireEvent(getByTestId('form-scroll-tap-area'), 'touchEnd', touch(100, 300));
    fireEvent.press(getByText('Save'));

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no input has the focus, or on a second finger', () => {
    const { getByText } = renderForm();
    const label = getByText('Gender');

    focusedInput.mockReturnValue(undefined);
    fireEvent(label, 'touchStart', touch(100, 300));
    fireEvent(label, 'touchEnd', touch(100, 300));

    focusedInput.mockReturnValue(FOCUSED);
    fireEvent(label, 'touchStart', touch(100, 300, 2));
    fireEvent(label, 'touchEnd', touch(100, 300));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('keeps controls pressable with the keyboard up', () => {
    expect(renderForm().UNSAFE_getByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('fills the viewport with the tap area, and leaves the content as tall as its children', () => {
    const { getByTestId, UNSAFE_getByType } = renderForm();

    expect(UNSAFE_getByType(ScrollView).props.contentContainerStyle).toEqual({ flexGrow: 1 });
    expect(getByTestId('form-scroll-tap-area').props.style).toEqual({ flexGrow: 1 });
    // The caller's style and nothing else: a stretched wrapper would make
    // every `flex: 1` Card share the leftover height.
    expect(getByTestId('form-scroll-content').props.style).toEqual({ padding: 16 });
  });

  describe('the temporary stuck-keyboard report', () => {
    const tapLabel = (last: 'touchEnd' | 'touchCancel' = 'touchEnd') => {
      const { getByText } = renderForm();
      fireEvent(getByText('Gender'), 'touchStart', touch(100, 300));
      fireEvent(getByText('Gender'), last, touch(102, 300));
      act(() => {
        jest.advanceTimersByTime(STUCK_CHECK_MS);
      });
    };

    it('says nothing when the field lost the focus', () => {
      dismiss.mockImplementation(() => focusedInput.mockReturnValue(undefined));

      tapLabel();

      expect(captureException).not.toHaveBeenCalled();
    });

    it('reports once per session when the field kept the focus, whatever the keyboard flag says', () => {
      tapLabel();
      tapLabel();

      expect(captureException).toHaveBeenCalledTimes(1);
      const [error, context, tags] = (captureException as jest.Mock).mock.calls[0];
      expect((error as Error).message).toBe('Input still focused after a dismissing tap');
      // No text and no ids.
      expect(context).toEqual({
        flow: 'form-keyboard-dismiss',
        phase: 'end',
        travel: 2,
        keyboardReportedVisible: false,
      });
      expect(tags).toEqual({ flow: 'form-keyboard-dismiss' });
    });

    it('reports a cancelled touch that did not move as its own kind', () => {
      tapLabel('touchCancel');
      tapLabel('touchCancel');
      tapLabel();

      expect((captureException as jest.Mock).mock.calls.map(([error]) => (error as Error).message)).toEqual([
        'Input still focused after a cancelled touch that did not move',
        'Input still focused after a dismissing tap',
      ]);
    });

    it('drops the pending check when the next touch is on a field', () => {
      const { getByText, getByTestId } = renderForm();
      fireEvent(getByText('Gender'), 'touchStart', touch(100, 300));
      fireEvent(getByText('Gender'), 'touchEnd', touch(100, 300));

      const start = touch(100, 200);
      fireEvent(getByTestId('age-group'), 'touchStart', start);
      fireEvent(getByTestId('form-scroll-tap-area'), 'touchStart', start);
      act(() => {
        jest.advanceTimersByTime(STUCK_CHECK_MS);
      });

      expect(captureException).not.toHaveBeenCalled();
    });
  });
});
