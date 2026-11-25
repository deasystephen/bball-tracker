/**
 * FormScrollView dismisses the keyboard on a tap no child handles (#1118),
 * without asking React Native whether a keyboard is open.
 */

import React from 'react';
import { Keyboard, ScrollView, Text, TouchableOpacity } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { FormScrollView } from '../../components/FormScrollView';

describe('FormScrollView', () => {
  let dismiss: jest.SpyInstance;

  beforeEach(() => {
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dismiss.mockRestore();
  });

  it('claims a tap that no child handles and dismisses the keyboard on release', () => {
    const { getByTestId } = render(
      <FormScrollView>
        <Text>Gender</Text>
      </FormScrollView>
    );
    const content = getByTestId('form-scroll-content');

    expect(content.props.onStartShouldSetResponder()).toBe(true);
    fireEvent(content, 'responderRelease');

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss when the scroll view takes the gesture over (a drag)', () => {
    const { getByTestId } = render(
      <FormScrollView>
        <Text>Gender</Text>
      </FormScrollView>
    );

    fireEvent(getByTestId('form-scroll-content'), 'responderTerminate');

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('leaves a press on a button to the button', () => {
    const onPress = jest.fn();
    const { getByText } = render(
      <FormScrollView>
        <TouchableOpacity onPress={onPress} accessibilityRole="button">
          <Text>Save</Text>
        </TouchableOpacity>
      </FormScrollView>
    );

    fireEvent.press(getByText('Save'));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('keeps taps on controls working while the keyboard is up, and pads the tappable wrapper', () => {
    const { getByTestId, UNSAFE_getByType } = render(
      <FormScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>Gender</Text>
      </FormScrollView>
    );

    expect(UNSAFE_getByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
    expect(getByTestId('form-scroll-content').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ flexGrow: 1 }), { padding: 16 }])
    );
  });
});
