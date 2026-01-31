/**
 * Tests for EmptyState component
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { EmptyState } from '../../components/EmptyState';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      textTertiary: '#999999',
      textSecondary: '#666666',
      primary: '#007AFF',
      textInverse: '#FFFFFF',
      border: '#E5E5E5',
      background: '#FFFFFF',
      card: '#FFFFFF',
    },
    isDark: false,
  }),
}));

// Mock responsive utils
jest.mock('../../utils/responsive', () => ({
  getResponsiveValue: (phone: number) => phone,
}));

describe('EmptyState', () => {
  describe('rendering', () => {
    it('should render title', () => {
      const { getByText } = render(<EmptyState title="No Items" />);
      expect(getByText('No Items')).toBeTruthy();
    });

    it('should render with default icon', () => {
      const { getByText } = render(<EmptyState title="No Items" />);
      // Icon renders as text in test environment
      expect(getByText('document-outline')).toBeTruthy();
    });

    it('should render custom icon', () => {
      const { getByText } = render(
        <EmptyState title="No Teams" icon="people-outline" />
      );
      expect(getByText('people-outline')).toBeTruthy();
    });

    it('should render message when provided', () => {
      const { getByText } = render(
        <EmptyState
          title="No Items"
          message="Create your first item to get started"
        />
      );
      expect(getByText('Create your first item to get started')).toBeTruthy();
    });

    it('should not render message when not provided', () => {
      const { queryByText } = render(<EmptyState title="No Items" />);
      // Ensure title is there but no extra message
      expect(queryByText('Create your first item to get started')).toBeNull();
    });
  });

  describe('action button', () => {
    it('should render action button when actionLabel and onAction are provided', () => {
      const onActionMock = jest.fn();
      const { getByText } = render(
        <EmptyState
          title="No Teams"
          actionLabel="Create Team"
          onAction={onActionMock}
        />
      );
      expect(getByText('Create Team')).toBeTruthy();
    });

    it('should not render action button when only actionLabel is provided', () => {
      const { queryByText } = render(
        <EmptyState title="No Teams" actionLabel="Create Team" />
      );
      expect(queryByText('Create Team')).toBeNull();
    });

    it('should not render action button when only onAction is provided', () => {
      const onActionMock = jest.fn();
      const { queryByText } = render(
        <EmptyState title="No Teams" onAction={onActionMock} />
      );
      // Button with default text shouldn't appear
      expect(queryByText('Create Team')).toBeNull();
    });

    it('should call onAction when action button is pressed', () => {
      const onActionMock = jest.fn();
      const { getByText } = render(
        <EmptyState
          title="No Teams"
          actionLabel="Create Team"
          onAction={onActionMock}
        />
      );

      fireEvent.press(getByText('Create Team'));
      expect(onActionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('complete states', () => {
    it('should render complete empty state with all props', () => {
      const onActionMock = jest.fn();
      const { getByText } = render(
        <EmptyState
          icon="basketball-outline"
          title="No Games Yet"
          message="Schedule your first game to start tracking"
          actionLabel="Schedule Game"
          onAction={onActionMock}
        />
      );

      expect(getByText('basketball-outline')).toBeTruthy();
      expect(getByText('No Games Yet')).toBeTruthy();
      expect(getByText('Schedule your first game to start tracking')).toBeTruthy();
      expect(getByText('Schedule Game')).toBeTruthy();
    });
  });
});
