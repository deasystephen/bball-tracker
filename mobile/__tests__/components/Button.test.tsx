/**
 * Tests for Button component
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Button } from '../../components/Button';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF',
      text: '#000000',
      textInverse: '#FFFFFF',
      textTertiary: '#999999',
      border: '#E5E5E5',
      error: '#FF3B30',
      backgroundSecondary: '#F2F2F7',
      card: '#FFFFFF',
    },
    isDark: false,
    toggleTheme: jest.fn(),
    theme: 'light',
  }),
}));

// Mock responsive utils
jest.mock('../../utils/responsive', () => ({
  getResponsiveValue: (phone: number) => phone,
}));

describe('Button', () => {
  describe('rendering', () => {
    it('should render with title', () => {
      const { getByText } = render(<Button title="Press Me" />);
      expect(getByText('Press Me')).toBeTruthy();
    });

    it('should render loading state', () => {
      const { getByTestId, queryByText } = render(
        <Button title="Press Me" loading testID="button" />
      );
      // Loading state should hide the text
      expect(queryByText('Press Me')).toBeNull();
    });
  });

  describe('variants', () => {
    it('should render primary variant by default', () => {
      const { getByText } = render(<Button title="Primary" />);
      expect(getByText('Primary')).toBeTruthy();
    });

    it('should render secondary variant', () => {
      const { getByText } = render(<Button title="Secondary" variant="secondary" />);
      expect(getByText('Secondary')).toBeTruthy();
    });

    it('should render outline variant', () => {
      const { getByText } = render(<Button title="Outline" variant="outline" />);
      expect(getByText('Outline')).toBeTruthy();
    });

    it('should render danger variant', () => {
      const { getByText } = render(<Button title="Danger" variant="danger" />);
      expect(getByText('Danger')).toBeTruthy();
    });
  });

  describe('sizes', () => {
    it('should render small size', () => {
      const { getByText } = render(<Button title="Small" size="small" />);
      expect(getByText('Small')).toBeTruthy();
    });

    it('should render medium size by default', () => {
      const { getByText } = render(<Button title="Medium" />);
      expect(getByText('Medium')).toBeTruthy();
    });

    it('should render large size', () => {
      const { getByText } = render(<Button title="Large" size="large" />);
      expect(getByText('Large')).toBeTruthy();
    });
  });

  describe('interaction', () => {
    it('should call onPress when pressed', () => {
      const onPressMock = jest.fn();
      const { getByText } = render(
        <Button title="Press Me" onPress={onPressMock} />
      );

      fireEvent.press(getByText('Press Me'));
      expect(onPressMock).toHaveBeenCalledTimes(1);
    });

    it('should not call onPress when disabled', () => {
      const onPressMock = jest.fn();
      const { getByText } = render(
        <Button title="Disabled" onPress={onPressMock} disabled />
      );

      fireEvent.press(getByText('Disabled'));
      expect(onPressMock).not.toHaveBeenCalled();
    });

    it('should not call onPress when loading', () => {
      const onPressMock = jest.fn();
      const { getByTestId } = render(
        <Button title="Loading" onPress={onPressMock} loading testID="loading-btn" />
      );

      fireEvent.press(getByTestId('loading-btn'));
      expect(onPressMock).not.toHaveBeenCalled();
    });
  });

  describe('fullWidth', () => {
    it('should render full width when fullWidth prop is true', () => {
      const { getByText } = render(<Button title="Full Width" fullWidth />);
      expect(getByText('Full Width')).toBeTruthy();
    });
  });
});
