/**
 * FormScrollView dismisses the keyboard on a tap no child handles (#1118),
 * without asking React Native whether a keyboard is open.
 */

import React from 'react';
import { Keyboard, ScrollView, Text, TouchableOpacity } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { FormScrollView, TAP_SLOP } from '../../components/FormScrollView';

const touch = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });

describe('FormScrollView', () => {
  let dismiss: jest.SpyInstance;

  beforeEach(() => {
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dismiss.mockRestore();
  });

  const renderForm = () =>
    render(
      <FormScrollView contentContainerStyle={{ padding: 16 }}>
        <Text>Gender</Text>
      </FormScrollView>
    );

  it('claims a tap that no child handles and dismisses the keyboard on release', () => {
    const area = renderForm().getByTestId('form-scroll-tap-area');

    expect(area.props.onStartShouldSetResponder()).toBe(true);
    fireEvent(area, 'responderGrant', touch(100, 300));
    fireEvent(area, 'responderRelease', touch(103, 296));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss when the scroll view takes the gesture over (a drag)', () => {
    const area = renderForm().getByTestId('form-scroll-tap-area');

    fireEvent(area, 'responderGrant', touch(100, 300));
    fireEvent(area, 'responderTerminate', touch(100, 200));

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss on a swipe that ends as a release (a form too short to scroll)', () => {
    const area = renderForm().getByTestId('form-scroll-tap-area');

    fireEvent(area, 'responderGrant', touch(100, 300));
    fireEvent(area, 'responderRelease', touch(100, 300 - TAP_SLOP - 1));

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

  it('keeps controls tappable with the keyboard up', () => {
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
});
