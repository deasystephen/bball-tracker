/**
 * KeyboardDismissView around a list with a composer (#1122): a tap on a row
 * or on empty space dismisses the keyboard, a tap on the field and a scroll
 * do not. The tap rules themselves are covered through FormScrollView, which
 * is built on this view (`FormScrollView.test.tsx`).
 */

import React from 'react';
import { FlatList, Keyboard, Text, TextInput } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { KeyboardDismissView, TAP_SLOP } from '../../components/KeyboardDismissView';
import { Input } from '../../components/Input';

let clock = 1000;
/** Every native touch event has its own timestamp; a bubbling one keeps it. */
const touch = (pageX: number, pageY: number) => ({
  nativeEvent: { pageX, pageY, timestamp: (clock += 16), touches: [{}] },
});

describe('KeyboardDismissView', () => {
  let dismiss: jest.SpyInstance;
  let focusedInput: jest.SpyInstance;
  const FOCUSED = { field: 'reply' } as unknown as ReturnType<typeof TextInput.State.currentlyFocusedInput>;

  beforeEach(() => {
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    focusedInput = jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(FOCUSED);
  });

  afterEach(() => {
    dismiss.mockRestore();
    focusedInput.mockRestore();
  });

  const renderThread = () =>
    render(
      <KeyboardDismissView style={{ flex: 1 }} testID="tap-area">
        <FlatList
          data={['See you there', 'Running late']}
          keyExtractor={(item) => item}
          renderItem={({ item }) => <Text>{item}</Text>}
          keyboardShouldPersistTaps="handled"
        />
        <Input placeholder="Reply" testID="reply" />
      </KeyboardDismissView>
    );

  it('dismisses the keyboard on a tap on a list row', () => {
    const { getByText } = renderThread();

    fireEvent(getByText('Running late'), 'touchStart', touch(100, 300));
    fireEvent(getByText('Running late'), 'touchEnd', touch(102, 303));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves the keyboard up for a tap on the field, a scroll and a cancelled touch', () => {
    const { getByText, getByTestId } = renderThread();
    const area = getByTestId('tap-area');

    // The field marks the touch before it bubbles to the tap area.
    const onField = touch(100, 600);
    fireEvent(getByTestId('reply'), 'touchStart', onField);
    fireEvent(area, 'touchStart', onField);
    fireEvent(area, 'touchEnd', touch(100, 600));

    fireEvent(getByText('See you there'), 'touchStart', touch(100, 300));
    fireEvent(getByText('See you there'), 'touchMove', touch(100, 300 - TAP_SLOP - 1));
    fireEvent(getByText('See you there'), 'touchEnd', touch(100, 300 - TAP_SLOP - 1));

    fireEvent(getByText('See you there'), 'touchStart', touch(100, 300));
    fireEvent(getByText('See you there'), 'touchCancel', touch(100, 304));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does nothing when no field has the focus', () => {
    focusedInput.mockReturnValue(null);
    const { getByText } = renderThread();

    fireEvent(getByText('See you there'), 'touchStart', touch(100, 300));
    fireEvent(getByText('See you there'), 'touchEnd', touch(100, 300));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('keeps the caller\'s view props and sets no responder', () => {
    const area = renderThread().getByTestId('tap-area');

    expect(area.props.style).toEqual({ flex: 1 });
    expect(area.props.onStartShouldSetResponder).toBeUndefined();
  });
});
