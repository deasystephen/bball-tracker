/**
 * Tests for ShotButtons.
 *
 * Verifies the 2x2 grid of made/missed buttons for 2pt and 3pt:
 *   - all four buttons are rendered with correct accessibility labels
 *   - each button calls onShot with the right (points, made) tuple
 *   - haptics fire (medium for made, light for miss)
 *   - disabled blocks presses and shows the "Select a player first" hint
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import { ShotButtons } from '../../../components/game/ShotButtons';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      success: '#0A0',
      error: '#A00',
    },
    colorScheme: 'light',
  }),
}));

const mockedImpactAsync = Haptics.impactAsync as jest.Mock;

describe('ShotButtons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all four shot buttons with their accessibility labels', () => {
    const { getByLabelText } = render(<ShotButtons onShot={jest.fn()} />);
    expect(getByLabelText('2-point shot made')).toBeTruthy();
    expect(getByLabelText('2-point shot missed')).toBeTruthy();
    expect(getByLabelText('3-point shot made')).toBeTruthy();
    expect(getByLabelText('3-point shot missed')).toBeTruthy();
  });

  it('renders MADE/MISS labels and point values on the buttons', () => {
    const { getAllByText } = render(<ShotButtons onShot={jest.fn()} />);
    expect(getAllByText('MADE').length).toBe(2);
    expect(getAllByText('MISS').length).toBe(2);
    expect(getAllByText('2PT').length).toBe(2);
    expect(getAllByText('3PT').length).toBe(2);
  });

  it('calls onShot with (2, true) when the 2-point made button is pressed', () => {
    const onShot = jest.fn();
    const { getByLabelText } = render(<ShotButtons onShot={onShot} />);

    fireEvent.press(getByLabelText('2-point shot made'));

    expect(onShot).toHaveBeenCalledTimes(1);
    expect(onShot).toHaveBeenCalledWith(2, true);
  });

  it('calls onShot with (2, false) when the 2-point missed button is pressed', () => {
    const onShot = jest.fn();
    const { getByLabelText } = render(<ShotButtons onShot={onShot} />);

    fireEvent.press(getByLabelText('2-point shot missed'));

    expect(onShot).toHaveBeenCalledWith(2, false);
  });

  it('calls onShot with (3, true) when the 3-point made button is pressed', () => {
    const onShot = jest.fn();
    const { getByLabelText } = render(<ShotButtons onShot={onShot} />);

    fireEvent.press(getByLabelText('3-point shot made'));

    expect(onShot).toHaveBeenCalledWith(3, true);
  });

  it('calls onShot with (3, false) when the 3-point missed button is pressed', () => {
    const onShot = jest.fn();
    const { getByLabelText } = render(<ShotButtons onShot={onShot} />);

    fireEvent.press(getByLabelText('3-point shot missed'));

    expect(onShot).toHaveBeenCalledWith(3, false);
  });

  it('triggers Medium haptic for a made shot and Light haptic for a miss', () => {
    const { getByLabelText } = render(<ShotButtons onShot={jest.fn()} />);

    fireEvent.press(getByLabelText('2-point shot made'));
    expect(mockedImpactAsync).toHaveBeenLastCalledWith(
      Haptics.ImpactFeedbackStyle.Medium
    );

    fireEvent.press(getByLabelText('2-point shot missed'));
    expect(mockedImpactAsync).toHaveBeenLastCalledWith(
      Haptics.ImpactFeedbackStyle.Light
    );
  });

  it('does not call onShot when disabled', () => {
    const onShot = jest.fn();
    const { getByLabelText, getByText } = render(
      <ShotButtons onShot={onShot} disabled />
    );

    fireEvent.press(getByLabelText('2-point shot made'));
    fireEvent.press(getByLabelText('3-point shot missed'));

    expect(onShot).not.toHaveBeenCalled();
    expect(mockedImpactAsync).not.toHaveBeenCalled();
    // Helper text appears in the disabled overlay.
    expect(getByText('Select a player first')).toBeTruthy();
  });

  it('does not render the disabled hint when enabled', () => {
    const { queryByText } = render(<ShotButtons onShot={jest.fn()} />);
    expect(queryByText('Select a player first')).toBeNull();
  });
});
