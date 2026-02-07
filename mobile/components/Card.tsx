/**
 * Themed Card component
 */

import React from 'react';
import { View, ViewProps, StyleSheet, TouchableOpacity, TouchableOpacityProps } from 'react-native';
import { ThemedView } from './ThemedView';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { getResponsiveValue } from '../utils/responsive';

interface CardProps extends ViewProps {
  variant?: 'default' | 'elevated';
  onPress?: () => void;
  children: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
  variant = 'default',
  onPress,
  style,
  children,
  ...props
}) => {
  const { colors } = useTheme();
  const padding = getResponsiveValue(spacing.md, spacing.lg);
  const borderRadius = getResponsiveValue(12, 16);

  const cardStyle = [
    styles.card,
    {
      backgroundColor: colors.card,
      padding,
      borderRadius,
      borderWidth: variant === 'elevated' ? 0 : 1,
      borderColor: colors.border,
      // Shadow for elevated variant (iOS)
      ...(variant === 'elevated' && {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4, // Android
      }),
    },
    style,
  ];

  if (onPress) {
    return (
      <TouchableOpacity
        style={cardStyle}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        {...(props as TouchableOpacityProps)}
      >
        {children}
      </TouchableOpacity>
    );
  }

  return (
    <ThemedView variant="card" style={cardStyle} {...props}>
      {children}
    </ThemedView>
  );
};

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
  },
});
