/**
 * Themed Card component
 */

import React from 'react';
import { View, ViewProps, StyleSheet, TouchableOpacity, TouchableOpacityProps } from 'react-native';
import { ThemedView } from './ThemedView';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { shadows, glow } from '../theme/shadows';
import { borderRadius } from '../theme/border-radius';
import { getResponsiveValue } from '../utils/responsive';

interface CardProps extends ViewProps {
  variant?: 'default' | 'elevated' | 'highlighted';
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

  const getShadow = () => {
    switch (variant) {
      case 'elevated':
        return shadows.lg;
      case 'highlighted':
        return glow(colors.live, 0.3);
      default:
        return shadows.md;
    }
  };

  const cardStyle = [
    styles.card,
    {
      backgroundColor: colors.card,
      padding,
      borderRadius: borderRadius.lg,
      ...getShadow(),
      ...(variant === 'highlighted' && {
        borderWidth: 2,
        borderColor: colors.live,
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
