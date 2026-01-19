/**
 * Themed View component that adapts to light/dark mode
 */

import React from 'react';
import { View, ViewProps, StyleSheet } from 'react-native';
import { useTheme } from '../hooks/useTheme';

interface ThemedViewProps extends ViewProps {
  variant?: 'background' | 'secondary' | 'tertiary' | 'card';
}

export const ThemedView: React.FC<ThemedViewProps> = ({
  style,
  variant = 'background',
  ...props
}) => {
  const { colors } = useTheme();

  const backgroundColor =
    variant === 'background'
      ? colors.background
      : variant === 'secondary'
      ? colors.backgroundSecondary
      : variant === 'tertiary'
      ? colors.backgroundTertiary
      : colors.card;

  return (
    <View
      style={[styles.container, { backgroundColor }, style]}
      {...props}
    />
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
