/**
 * Tests for Input component
 */

import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { Input } from '../../components/Input';

// Mock useTheme hook
jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      text: '#000000',
      textSecondary: '#666666',
      textTertiary: '#999999',
      inputBackground: '#F5F5F5',
      inputBorder: '#E5E5E5',
      inputPlaceholder: '#AAAAAA',
      error: '#FF3B30',
    },
    isDark: false,
  }),
}));

// Mock responsive utils
jest.mock('../../utils/responsive', () => ({
  getResponsiveValue: (phone: number) => phone,
}));

describe('Input', () => {
  describe('rendering', () => {
    it('should render basic input', () => {
      const { getByPlaceholderText } = render(
        <Input placeholder="Enter text" />
      );
      expect(getByPlaceholderText('Enter text')).toBeTruthy();
    });

    it('should render with label', () => {
      const { getByText } = render(
        <Input label="Email" placeholder="Enter email" />
      );
      expect(getByText('Email')).toBeTruthy();
    });

    it('should render without label', () => {
      const { queryByText, getByPlaceholderText } = render(
        <Input placeholder="Enter text" />
      );
      expect(getByPlaceholderText('Enter text')).toBeTruthy();
      // No label should be present
      expect(queryByText('Email')).toBeNull();
    });
  });

  describe('error state', () => {
    it('should display error message', () => {
      const { getByText } = render(
        <Input placeholder="Enter email" error="Invalid email address" />
      );
      expect(getByText('Invalid email address')).toBeTruthy();
    });

    it('should not display error when not provided', () => {
      const { queryByText } = render(
        <Input placeholder="Enter email" />
      );
      expect(queryByText('Invalid email address')).toBeNull();
    });
  });

  describe('helper text', () => {
    it('should display helper text', () => {
      const { getByText } = render(
        <Input placeholder="Enter password" helperText="Must be at least 8 characters" />
      );
      expect(getByText('Must be at least 8 characters')).toBeTruthy();
    });

    it('should show error instead of helper text when both provided', () => {
      const { getByText, queryByText } = render(
        <Input
          placeholder="Enter email"
          helperText="We'll never share your email"
          error="Invalid email"
        />
      );
      expect(getByText('Invalid email')).toBeTruthy();
      // Helper text should be replaced by error
      expect(queryByText("We'll never share your email")).toBeNull();
    });
  });

  describe('icons', () => {
    it('should render left icon', () => {
      const { getByText } = render(
        <Input
          placeholder="Search"
          leftIcon={<Text>SearchIcon</Text>}
        />
      );
      expect(getByText('SearchIcon')).toBeTruthy();
    });

    it('should render right icon', () => {
      const { getByText } = render(
        <Input
          placeholder="Password"
          rightIcon={<Text>EyeIcon</Text>}
        />
      );
      expect(getByText('EyeIcon')).toBeTruthy();
    });

    it('should render both icons', () => {
      const { getByText } = render(
        <Input
          placeholder="Search"
          leftIcon={<Text>LeftIcon</Text>}
          rightIcon={<Text>RightIcon</Text>}
        />
      );
      expect(getByText('LeftIcon')).toBeTruthy();
      expect(getByText('RightIcon')).toBeTruthy();
    });
  });

  describe('interaction', () => {
    it('should call onChangeText when text changes', () => {
      const onChangeTextMock = jest.fn();
      const { getByPlaceholderText } = render(
        <Input placeholder="Enter text" onChangeText={onChangeTextMock} />
      );

      fireEvent.changeText(getByPlaceholderText('Enter text'), 'Hello');
      expect(onChangeTextMock).toHaveBeenCalledWith('Hello');
    });

    it('should call onFocus when focused', () => {
      const onFocusMock = jest.fn();
      const { getByPlaceholderText } = render(
        <Input placeholder="Enter text" onFocus={onFocusMock} />
      );

      fireEvent(getByPlaceholderText('Enter text'), 'focus');
      expect(onFocusMock).toHaveBeenCalled();
    });

    it('should call onBlur when blurred', () => {
      const onBlurMock = jest.fn();
      const { getByPlaceholderText } = render(
        <Input placeholder="Enter text" onBlur={onBlurMock} />
      );

      fireEvent(getByPlaceholderText('Enter text'), 'blur');
      expect(onBlurMock).toHaveBeenCalled();
    });
  });

  describe('value handling', () => {
    it('should display controlled value', () => {
      const { getByDisplayValue } = render(
        <Input placeholder="Enter text" value="Controlled value" />
      );
      expect(getByDisplayValue('Controlled value')).toBeTruthy();
    });

    it('should display default value', () => {
      const { getByDisplayValue } = render(
        <Input placeholder="Enter text" defaultValue="Default value" />
      );
      expect(getByDisplayValue('Default value')).toBeTruthy();
    });
  });

  describe('complete input', () => {
    it('should render complete input with all props', () => {
      const onChangeTextMock = jest.fn();
      const { getByText, getByPlaceholderText } = render(
        <Input
          label="Email Address"
          placeholder="Enter your email"
          helperText="We'll never share your email"
          leftIcon={<Text>@</Text>}
          onChangeText={onChangeTextMock}
        />
      );

      expect(getByText('Email Address')).toBeTruthy();
      expect(getByPlaceholderText('Enter your email')).toBeTruthy();
      expect(getByText("We'll never share your email")).toBeTruthy();
      expect(getByText('@')).toBeTruthy();
    });
  });
});
