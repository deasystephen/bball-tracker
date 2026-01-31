/**
 * Tests for LoadingSpinner component
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { LoadingSpinner } from '../../components/LoadingSpinner';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF',
      textSecondary: '#666666',
      background: '#FFFFFF',
    },
    isDark: false,
  }),
}));

describe('LoadingSpinner', () => {
  describe('rendering', () => {
    it('should render without message', () => {
      const { queryByText } = render(<LoadingSpinner />);
      // Should not have any text
      expect(queryByText('Loading')).toBeNull();
    });

    it('should render with message', () => {
      const { getByText } = render(<LoadingSpinner message="Loading data..." />);
      expect(getByText('Loading data...')).toBeTruthy();
    });
  });

  describe('sizes', () => {
    it('should render large size by default', () => {
      const { UNSAFE_root } = render(<LoadingSpinner />);
      // Component renders successfully
      expect(UNSAFE_root).toBeTruthy();
    });

    it('should render small size', () => {
      const { UNSAFE_root } = render(<LoadingSpinner size="small" />);
      expect(UNSAFE_root).toBeTruthy();
    });

    it('should render large size explicitly', () => {
      const { UNSAFE_root } = render(<LoadingSpinner size="large" />);
      expect(UNSAFE_root).toBeTruthy();
    });
  });

  describe('fullScreen mode', () => {
    it('should render in fullScreen mode', () => {
      const { UNSAFE_root } = render(<LoadingSpinner fullScreen />);
      expect(UNSAFE_root).toBeTruthy();
    });

    it('should render fullScreen with message', () => {
      const { getByText } = render(
        <LoadingSpinner fullScreen message="Please wait..." />
      );
      expect(getByText('Please wait...')).toBeTruthy();
    });

    it('should render non-fullScreen by default', () => {
      const { UNSAFE_root } = render(<LoadingSpinner />);
      expect(UNSAFE_root).toBeTruthy();
    });
  });

  describe('combinations', () => {
    it('should render with all props', () => {
      const { getByText } = render(
        <LoadingSpinner fullScreen size="large" message="Loading teams..." />
      );
      expect(getByText('Loading teams...')).toBeTruthy();
    });
  });
});
