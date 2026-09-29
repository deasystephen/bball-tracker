/**
 * Tests for ErrorState component
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ErrorState } from '../../components/ErrorState';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      error: '#FF3B30',
      textSecondary: '#666666',
      primary: '#007AFF',
      textInverse: '#FFFFFF',
      background: '#FFFFFF',
      card: '#FFFFFF',
      border: '#E5E5E5',
    },
    isDark: false,
  }),
}));

// Mock responsive utils
jest.mock('../../utils/responsive', () => ({
  getResponsiveValue: (phone: number) => phone,
}));

describe('ErrorState', () => {
  describe('rendering', () => {
    it('should render error message', () => {
      const { getByText } = render(<ErrorState message="Network request failed" />);
      expect(getByText('Network request failed')).toBeTruthy();
    });

    it('should render error icon', () => {
      const { getByText } = render(<ErrorState message="Error occurred" />);
      // Icon renders as text in test environment
      expect(getByText('alert-circle-outline')).toBeTruthy();
    });

    it('should render with title when provided', () => {
      const { getByText } = render(
        <ErrorState title="Error" message="Something went wrong" />
      );
      expect(getByText('Error')).toBeTruthy();
      expect(getByText('Something went wrong')).toBeTruthy();
    });

    it('should render default title when not explicitly provided', () => {
      const { getByText } = render(
        <ErrorState message="Please try again later" />
      );
      expect(getByText('Something went wrong')).toBeTruthy();
      expect(getByText('Please try again later')).toBeTruthy();
    });
  });

  describe('retry button', () => {
    it('should render retry button when onRetry is provided', () => {
      const onRetryMock = jest.fn();
      const { getByText } = render(
        <ErrorState message="Something went wrong" onRetry={onRetryMock} />
      );
      expect(getByText('Try Again')).toBeTruthy();
    });

    it('should not render retry button when onRetry is not provided', () => {
      const { queryByText } = render(
        <ErrorState message="Something went wrong" />
      );
      expect(queryByText('Try Again')).toBeNull();
    });

    it('should use custom retry label', () => {
      const onRetryMock = jest.fn();
      const { getByText } = render(
        <ErrorState
          message="Something went wrong"
          onRetry={onRetryMock}
          retryLabel="Reconnect"
        />
      );
      expect(getByText('Reconnect')).toBeTruthy();
    });

    it('should call onRetry when retry button is pressed', () => {
      const onRetryMock = jest.fn();
      const { getByText } = render(
        <ErrorState message="Something went wrong" onRetry={onRetryMock} />
      );

      fireEvent.press(getByText('Try Again'));
      expect(onRetryMock).toHaveBeenCalledTimes(1);
    });
  });

  // #589: an error that replaces a pushed screen takes the header and its
  // back arrow with it.
  describe('back button', () => {
    it('is absent unless onBack is provided', () => {
      const { queryByText } = render(<ErrorState message="Something went wrong" onRetry={jest.fn()} />);
      expect(queryByText('Go back')).toBeNull();
    });

    it('calls onBack, and leaves onRetry alone', () => {
      const onBack = jest.fn();
      const onRetry = jest.fn();
      const { getByLabelText } = render(
        <ErrorState message="Something went wrong" onRetry={onRetry} onBack={onBack} />
      );

      fireEvent.press(getByLabelText('Go back'));

      expect(onBack).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it('can be the only button, with its own label', () => {
      const { getByText, queryByText } = render(
        <ErrorState message="Something went wrong" onBack={jest.fn()} backLabel="Back to team" />
      );

      expect(getByText('Back to team')).toBeTruthy();
      expect(queryByText('Try Again')).toBeNull();
    });
  });

  describe('complete error state', () => {
    it('should render complete error state with all props', () => {
      const onRetryMock = jest.fn();
      const { getByText } = render(
        <ErrorState
          title="Connection Error"
          message="Unable to connect to server. Please check your internet connection."
          onRetry={onRetryMock}
          retryLabel="Reconnect"
        />
      );

      expect(getByText('alert-circle-outline')).toBeTruthy();
      expect(getByText('Connection Error')).toBeTruthy();
      expect(getByText('Unable to connect to server. Please check your internet connection.')).toBeTruthy();
      expect(getByText('Reconnect')).toBeTruthy();
    });
  });
});
