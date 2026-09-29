/**
 * Tests for DateTimePickerSheet (#576).
 *
 * The picker it replaces was rendered inline and closed itself on the first
 * change. The rules pinned here: moving a wheel commits nothing and closes
 * nothing, Done commits the draft, Cancel and the backdrop discard it, and
 * every opening starts from the value the screen holds.
 */

import React from 'react';
import { Platform } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { DateTimePickerSheet } from '../../components/DateTimePickerSheet';

jest.mock('@react-native-community/datetimepicker', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => mockReact.createElement(View, props),
  };
});

const OPENED_ON = new Date('2026-10-03T18:30:00Z');
const PICKED = new Date('2026-11-14T18:30:00Z');

function setup(overrides: Partial<React.ComponentProps<typeof DateTimePickerSheet>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const props = {
    visible: true,
    mode: 'date' as const,
    value: OPENED_ON,
    title: 'Game date',
    onConfirm,
    onCancel,
    ...overrides,
  };
  const view = render(<DateTimePickerSheet {...props} />);
  return { ...view, props, onConfirm, onCancel };
}

const moveWheels = (view: ReturnType<typeof render>, to: Date) =>
  fireEvent(view.getByTestId('date-time-picker'), 'onValueChange', { nativeEvent: {} }, to);

describe('DateTimePickerSheet', () => {
  it('renders nothing while closed', () => {
    const view = setup({ visible: false });
    expect(view.toJSON()).toBeNull();
  });

  describe('on iOS', () => {
    it('shows the title, Cancel and Done around wheels opened on the current value', () => {
      const view = setup({ mode: 'time', title: 'Game time' });

      expect(view.getByText('Game time')).toBeTruthy();
      expect(view.getByLabelText('Cancel')).toBeTruthy();
      expect(view.getByLabelText('Done')).toBeTruthy();

      const picker = view.getByTestId('date-time-picker');
      expect(picker.props.value).toEqual(OPENED_ON);
      expect(picker.props.mode).toBe('time');
      expect(picker.props.display).toBe('spinner');
    });

    it('keeps the sheet open and commits nothing when a wheel moves', () => {
      const view = setup();

      moveWheels(view, PICKED);

      expect(view.onConfirm).not.toHaveBeenCalled();
      expect(view.onCancel).not.toHaveBeenCalled();
      expect(view.getByLabelText('Done')).toBeTruthy();
      expect(view.getByTestId('date-time-picker').props.value).toEqual(PICKED);
    });

    it('commits the last wheel position on Done', () => {
      const view = setup();

      moveWheels(view, new Date('2026-10-20T18:30:00Z'));
      moveWheels(view, PICKED);
      fireEvent.press(view.getByLabelText('Done'));

      expect(view.onConfirm).toHaveBeenCalledTimes(1);
      expect(view.onConfirm).toHaveBeenCalledWith(PICKED);
      expect(view.onCancel).not.toHaveBeenCalled();
    });

    it('commits the opening value when Done is pressed without touching the wheels', () => {
      const view = setup();

      fireEvent.press(view.getByLabelText('Done'));

      expect(view.onConfirm).toHaveBeenCalledWith(OPENED_ON);
    });

    it.each(['Cancel', 'Close picker'])('discards the draft on "%s"', (label) => {
      const view = setup();

      moveWheels(view, PICKED);
      fireEvent.press(view.getByLabelText(label));

      expect(view.onCancel).toHaveBeenCalledTimes(1);
      expect(view.onConfirm).not.toHaveBeenCalled();
    });

    it('starts from the screen value again after a cancelled edit', () => {
      const view = setup();
      moveWheels(view, PICKED);

      view.rerender(<DateTimePickerSheet {...view.props} visible={false} />);
      view.rerender(<DateTimePickerSheet {...view.props} visible />);

      expect(view.getByTestId('date-time-picker').props.value).toEqual(OPENED_ON);
    });

    it('follows the app theme', () => {
      const view = setup();
      expect(['light', 'dark']).toContain(view.getByTestId('date-time-picker').props.themeVariant);
    });
  });

  describe('on Android', () => {
    let platform: jest.ReplaceProperty<typeof Platform.OS>;

    beforeEach(() => {
      platform = jest.replaceProperty(Platform, 'OS', 'android');
    });

    afterEach(() => {
      platform.restore();
    });

    it('leaves the chrome to the system dialog', () => {
      const view = setup();

      expect(view.getByTestId('date-time-picker')).toBeTruthy();
      expect(view.queryByLabelText('Done')).toBeNull();
      expect(view.queryByLabelText('Cancel')).toBeNull();
    });

    it('commits what the dialog returns and reports a dismissal', () => {
      const view = setup();

      moveWheels(view, PICKED);
      expect(view.onConfirm).toHaveBeenCalledWith(PICKED);

      fireEvent(view.getByTestId('date-time-picker'), 'onDismiss');
      expect(view.onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
