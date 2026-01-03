/**
 * Themed Text component that adapts to light/dark mode
 */

import React from 'react';
import { Text, TextProps, StyleSheet } from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { typography, TypographyVariant } from '../theme/typography';

interface ThemedTextProps extends TextProps {
  variant?: TypographyVariant;
  color?: 'text' | 'textSecondary' | 'textTertiary' | 'primary' | 'error' | 'success';
}

export const ThemedText: React.FC<ThemedTextProps> = ({
  style,
  variant = 'body',
  color = 'text',
  ...props
}) => {
  const { colors } = useTheme();

  const textColor =
    color === 'text'
      ? colors.text
      : color === 'textSecondary'
      ? colors.textSecondary
      : color === 'textTertiary'
      ? colors.textTertiary
      : color === 'primary'
      ? colors.primary
      : color === 'error'
      ? colors.error
      : colors.success;

  return (
    <Text
      style={[
        typography[variant],
        { color: textColor },
        style,
      ]}
      {...props}
    />
  );
};

const styles = StyleSheet.create({});
