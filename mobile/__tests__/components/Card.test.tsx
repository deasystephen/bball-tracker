/**
 * Tests for Card component
 */

import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { Card } from '../../components/Card';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      card: '#FFFFFF',
      border: '#E5E5E5',
      background: '#F8F8F8',
    },
    isDark: false,
  }),
}));

// Mock responsive utils
jest.mock('../../utils/responsive', () => ({
  getResponsiveValue: (phone: number) => phone,
}));

describe('Card', () => {
  describe('rendering', () => {
    it('should render children', () => {
      const { getByText } = render(
        <Card>
          <Text>Card Content</Text>
        </Card>
      );
      expect(getByText('Card Content')).toBeTruthy();
    });

    it('should render multiple children', () => {
      const { getByText } = render(
        <Card>
          <Text>First Child</Text>
          <Text>Second Child</Text>
        </Card>
      );
      expect(getByText('First Child')).toBeTruthy();
      expect(getByText('Second Child')).toBeTruthy();
    });
  });

  describe('variants', () => {
    it('should render default variant', () => {
      const { getByText } = render(
        <Card variant="default">
          <Text>Default Card</Text>
        </Card>
      );
      expect(getByText('Default Card')).toBeTruthy();
    });

    it('should render elevated variant', () => {
      const { getByText } = render(
        <Card variant="elevated">
          <Text>Elevated Card</Text>
        </Card>
      );
      expect(getByText('Elevated Card')).toBeTruthy();
    });
  });

  describe('interaction', () => {
    it('should be pressable when onPress is provided', () => {
      const onPressMock = jest.fn();
      const { getByText } = render(
        <Card onPress={onPressMock}>
          <Text>Pressable Card</Text>
        </Card>
      );

      fireEvent.press(getByText('Pressable Card'));
      expect(onPressMock).toHaveBeenCalledTimes(1);
    });

    it('should not be pressable when onPress is not provided', () => {
      const { getByText } = render(
        <Card>
          <Text>Non-Pressable Card</Text>
        </Card>
      );
      // Component should still render
      expect(getByText('Non-Pressable Card')).toBeTruthy();
    });
  });

  describe('styling', () => {
    it('should accept custom style prop', () => {
      const { getByText } = render(
        <Card style={{ marginTop: 20 }}>
          <Text>Styled Card</Text>
        </Card>
      );
      expect(getByText('Styled Card')).toBeTruthy();
    });
  });
});
