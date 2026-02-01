/**
 * Reusable stat row component for displaying label-value pairs
 */

import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { ThemedText } from '../ThemedText';
import { spacing } from '../../theme';

interface StatRowProps {
  label: string;
  value: string | number;
  subtitle?: string;
  style?: ViewStyle;
  size?: 'small' | 'medium' | 'large';
}

export const StatRow: React.FC<StatRowProps> = ({
  label,
  value,
  subtitle,
  style,
  size = 'medium',
}) => {
  const valueVariant = size === 'large' ? 'h2' : size === 'small' ? 'body' : 'h3';
  const labelVariant = size === 'large' ? 'body' : 'caption';

  return (
    <View style={[styles.container, style]}>
      <ThemedText variant={valueVariant}>{value}</ThemedText>
      <ThemedText variant={labelVariant} color="textSecondary">
        {label}
      </ThemedText>
      {subtitle && (
        <ThemedText variant="caption" color="textTertiary">
          {subtitle}
        </ThemedText>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: spacing.sm,
  },
});
