/**
 * Tests for StatButtons.
 *
 * Verifies the five stat buttons (OREB, DREB, AST, STL, BLK) render with
 * the right labels and accessibility text, dispatch their stat type when
 * pressed, fire a Light haptic, and respect the disabled state.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import { StatButtons } from '../../../components/game/StatButtons';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      success: '#0A0',
      info: '#06C',
      primary: '#22F',
      warning: '#F90',
      error: '#A00',
      backgroundSecondary: '#EEE',
      border: '#DDD',
      textTertiary: '#999',
    },
    colorScheme: 'light',
  }),
}));

const mockedImpactAsync = Haptics.impactAsync as jest.Mock;

describe('StatButtons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the section label and all five stat buttons', () => {
    const { getByText } = render(<StatButtons onStat={jest.fn()} />);
    expect(getByText('Other Stats')).toBeTruthy();
    expect(getByText('OREB')).toBeTruthy();
    expect(getByText('DREB')).toBeTruthy();
    expect(getByText('AST')).toBeTruthy();
    expect(getByText('STL')).toBeTruthy();
    expect(getByText('BLK')).toBeTruthy();
  });

  it('exposes accessibility labels for each stat button', () => {
    const { getByLabelText } = render(<StatButtons onStat={jest.fn()} />);
    expect(getByLabelText('Record Off Reb')).toBeTruthy();
    expect(getByLabelText('Record Def Reb')).toBeTruthy();
    expect(getByLabelText('Record Assist')).toBeTruthy();
    expect(getByLabelText('Record Steal')).toBeTruthy();
    expect(getByLabelText('Record Block')).toBeTruthy();
  });

  it.each([
    ['Record Off Reb', 'OREB'],
    ['Record Def Reb', 'DREB'],
    ['Record Assist', 'AST'],
    ['Record Steal', 'STL'],
    ['Record Block', 'BLK'],
  ])('press on "%s" dispatches stat type %s', (label, type) => {
    const onStat = jest.fn();
    const { getByLabelText } = render(<StatButtons onStat={onStat} />);
    fireEvent.press(getByLabelText(label));
    expect(onStat).toHaveBeenCalledTimes(1);
    expect(onStat).toHaveBeenCalledWith(type);
  });

  it('fires a Light haptic on each press', () => {
    const { getByLabelText } = render(<StatButtons onStat={jest.fn()} />);
    fireEvent.press(getByLabelText('Record Assist'));
    expect(mockedImpactAsync).toHaveBeenCalledWith(
      Haptics.ImpactFeedbackStyle.Light
    );
  });

  it('does not invoke onStat or haptics when disabled, and shows the hint', () => {
    const onStat = jest.fn();
    const { getByLabelText, getByText } = render(
      <StatButtons onStat={onStat} disabled />
    );

    fireEvent.press(getByLabelText('Record Off Reb'));
    fireEvent.press(getByLabelText('Record Block'));

    expect(onStat).not.toHaveBeenCalled();
    expect(mockedImpactAsync).not.toHaveBeenCalled();
    expect(getByText('Select a player first')).toBeTruthy();
  });

  it('does not show the disabled hint when enabled', () => {
    const { queryByText } = render(<StatButtons onStat={jest.fn()} />);
    expect(queryByText('Select a player first')).toBeNull();
  });
});
