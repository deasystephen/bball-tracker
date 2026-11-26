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

const touch = (pageX: number, pageY: number, touches = 1) => ({
  nativeEvent: { pageX, pageY, touches: Array.from({ length: touches }, () => ({})) },
});

describe('FormScrollView', () => {
  let dismiss: jest.SpyInstance;
  let focusedInput: jest.SpyInstance;
  let keyboardVisible: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    resetStuckKeyboardReport();
    (captureException as jest.Mock).mockClear();
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    keyboardVisible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    // An input has the focus unless a test says otherwise.
    focusedInput = jest
      .spyOn(TextInput.State, 'currentlyFocusedInput')
      .mockReturnValue({} as ReturnType<typeof TextInput.State.currentlyFocusedInput>);
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

  it('dismisses when the system cancels a touch that did not move', () => {
    const { getByText } = renderForm();

    fireEvent(getByText('Gender'), 'touchStart', touch(100, 300));
    fireEvent(getByText('Gender'), 'touchCancel', touch(100, 301));

    expect(dismiss).toHaveBeenCalledTimes(1);
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

    // fireEvent calls one handler; on a device the touch bubbles from the
    // field (which marks it) to the tap area.
    fireEvent(getByTestId('age-group'), 'touchStart', touch(100, 200));
    fireEvent(area, 'touchStart', touch(100, 200));
    fireEvent(area, 'touchEnd', touch(100, 200));

    expect(dismiss).not.toHaveBeenCalled();

    // The mark is spent: the next tap elsewhere dismisses.
    fireEvent(area, 'touchStart', touch(100, 300));
    fireEvent(area, 'touchEnd', touch(100, 300));

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

    focusedInput.mockReturnValue({} as ReturnType<typeof TextInput.State.currentlyFocusedInput>);
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
    const tapLabel = () => {
      const { getByText } = renderForm();
      fireEvent(getByText('Gender'), 'touchStart', touch(100, 300));
      fireEvent(getByText('Gender'), 'touchEnd', touch(102, 300));
      act(() => {
        jest.advanceTimersByTime(STUCK_CHECK_MS);
      });
    };

    it('says nothing when the keyboard went away', () => {
      tapLabel();

      expect(captureException).not.toHaveBeenCalled();
    });

    it('reports once per session when the keyboard is still up, with no text and no ids', () => {
      keyboardVisible.mockReturnValue(true);

      tapLabel();
      tapLabel();

      expect(captureException).toHaveBeenCalledTimes(1);
      const [error, context, tags] = (captureException as jest.Mock).mock.calls[0];
      expect((error as Error).message).toBe('Keyboard still visible after a dismissing tap');
      expect(context).toEqual({
        flow: 'form-keyboard-dismiss',
        phase: 'end',
        travel: 2,
        focusedRightAfterDismiss: true,
        focusedLater: true,
        sameInputFocusedLater: true,
      });
      expect(tags).toEqual({ flow: 'form-keyboard-dismiss' });
    });
  });
});
