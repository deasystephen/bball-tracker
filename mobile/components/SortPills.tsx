/**
 * Horizontal sort-option pill row, shared by the team overview roster and the
 * team stats screen. Tinted-primary active style; each pill is labelled
 * "Sort by <label>" with `accessibilityState.selected` (Maestro asserts both).
 * Pills are full 44pt touch targets.
 */

import React from 'react';
import { View, TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing, borderRadius } from '../theme';

export interface SortPillOption<K extends string> {
  key: K;
  label: string;
}

interface SortPillsProps<K extends string> {
  options: readonly SortPillOption<K>[];
  selected: K;
  onSelect: (key: K) => void;
  style?: StyleProp<ViewStyle>;
}

export function SortPills<K extends string>({
  options,
  selected,
  onSelect,
  style,
}: SortPillsProps<K>) {
  const { colors } = useTheme();

  return (
    <View style={[styles.row, style]}>
      {options.map((option) => {
        const isSelected = selected === option.key;
        return (
          <TouchableOpacity
            key={option.key}
            onPress={() => onSelect(option.key)}
            style={[
              styles.pill,
              {
                backgroundColor: isSelected ? colors.primary + '20' : 'transparent',
                borderColor: isSelected ? colors.primary : colors.border,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Sort by ${option.label}`}
            accessibilityState={{ selected: isSelected }}
          >
            <ThemedText variant="caption" color={isSelected ? 'primary' : 'textSecondary'}>
              {option.label}
            </ThemedText>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    // 44pt minimum touch target (was 36 in the pre-extraction copies).
    minHeight: 44,
    justifyContent: 'center',
  },
});
