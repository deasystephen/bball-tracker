/**
 * The shared header back control (#655, #772 review): a button labelled
 * "Go back" (Maestro taps it by that label) with a 44pt target, whose press
 * is the caller's own way back.
 */

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';

import { BackButton } from '../../components/BackButton';
import { HEADER_ICON_HIT_SLOP } from '../../utils/touch-target';

describe('BackButton', () => {
  it('is a button labelled "Go back" that runs the caller\'s onPress', () => {
    const onPress = jest.fn();
    render(<BackButton onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Go back' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('reaches 44pt through the header hitSlop', () => {
    render(<BackButton onPress={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Go back' }).props.hitSlop).toEqual(HEADER_ICON_HIT_SLOP);
    expect(HEADER_ICON_HIT_SLOP).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
  });

  it('keeps the "Go back" label when drawn as a close icon', () => {
    render(<BackButton onPress={jest.fn()} icon="close" color="#FFFFFF" />);

    expect(screen.getByRole('button', { name: 'Go back' })).toBeTruthy();
  });
});
