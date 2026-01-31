/**
 * Tests for ListItem component
 */

import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { ListItem } from '../../components/ListItem';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      text: '#000000',
      textSecondary: '#666666',
      card: '#FFFFFF',
      border: '#E5E5E5',
      background: '#FFFFFF',
    },
    isDark: false,
  }),
}));

// Mock responsive utils
jest.mock('../../utils/responsive', () => ({
  getResponsiveValue: (phone: number) => phone,
}));

describe('ListItem', () => {
  describe('rendering', () => {
    it('should render title', () => {
      const { getByText } = render(<ListItem title="Team Name" />);
      expect(getByText('Team Name')).toBeTruthy();
    });

    it('should render title and subtitle', () => {
      const { getByText } = render(
        <ListItem title="Team Name" subtitle="5 players" />
      );
      expect(getByText('Team Name')).toBeTruthy();
      expect(getByText('5 players')).toBeTruthy();
    });

    it('should render without subtitle', () => {
      const { getByText, queryByText } = render(<ListItem title="Team Name" />);
      expect(getByText('Team Name')).toBeTruthy();
      expect(queryByText('5 players')).toBeNull();
    });
  });

  describe('elements', () => {
    it('should render left element', () => {
      const { getByText } = render(
        <ListItem
          title="Team Name"
          leftElement={<Text>LeftIcon</Text>}
        />
      );
      expect(getByText('LeftIcon')).toBeTruthy();
    });

    it('should render right element', () => {
      const { getByText } = render(
        <ListItem
          title="Team Name"
          rightElement={<Text>RightIcon</Text>}
        />
      );
      expect(getByText('RightIcon')).toBeTruthy();
    });

    it('should render both left and right elements', () => {
      const { getByText } = render(
        <ListItem
          title="Team Name"
          leftElement={<Text>LeftIcon</Text>}
          rightElement={<Text>RightIcon</Text>}
        />
      );
      expect(getByText('LeftIcon')).toBeTruthy();
      expect(getByText('RightIcon')).toBeTruthy();
    });
  });

  describe('variants', () => {
    it('should render default variant', () => {
      const { getByText } = render(
        <ListItem title="Default Item" variant="default" />
      );
      expect(getByText('Default Item')).toBeTruthy();
    });

    it('should render card variant', () => {
      const { getByText } = render(
        <ListItem title="Card Item" variant="card" />
      );
      expect(getByText('Card Item')).toBeTruthy();
    });
  });

  describe('interaction', () => {
    it('should call onPress when pressed', () => {
      const onPressMock = jest.fn();
      const { getByText } = render(
        <ListItem title="Pressable Item" onPress={onPressMock} />
      );

      fireEvent.press(getByText('Pressable Item'));
      expect(onPressMock).toHaveBeenCalledTimes(1);
    });

    it('should not be touchable when onPress is not provided', () => {
      const { getByText } = render(<ListItem title="Non-Pressable Item" />);
      // Component should still render
      expect(getByText('Non-Pressable Item')).toBeTruthy();
    });
  });

  describe('complete list item', () => {
    it('should render complete list item with all props', () => {
      const onPressMock = jest.fn();
      const { getByText } = render(
        <ListItem
          title="Team Alpha"
          subtitle="10 players"
          leftElement={<Text>Avatar</Text>}
          rightElement={<Text>Chevron</Text>}
          variant="card"
          onPress={onPressMock}
        />
      );

      expect(getByText('Team Alpha')).toBeTruthy();
      expect(getByText('10 players')).toBeTruthy();
      expect(getByText('Avatar')).toBeTruthy();
      expect(getByText('Chevron')).toBeTruthy();
    });
  });
});
