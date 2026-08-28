/**
 * Guardian relationship radio chips — shared by the roster Add Player form
 * and the per-player Guardians screen (extracted by the unification review;
 * previously duplicated with a hardcoded selected-text color that failed
 * contrast in dark mode — textInverse fixes it, same as Button).
 */

import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing, borderRadius } from '../theme';
import { GUARDIAN_RELATIONSHIPS, relationshipLabel } from '../utils/guardian';
import type { GuardianRelationship } from '../../shared/types';

export interface RelationshipChipsProps {
  value: GuardianRelationship;
  onChange: (value: GuardianRelationship) => void;
}

export function RelationshipChips({ value, onChange }: RelationshipChipsProps) {
  const { colors } = useTheme();

  return (
    <View style={styles.chipRow}>
      {GUARDIAN_RELATIONSHIPS.map((relationship) => {
        const selected = relationship === value;
        return (
          <TouchableOpacity
            key={relationship}
            onPress={() => onChange(relationship)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={relationshipLabel(relationship)}
            style={[
              styles.chip,
              {
                backgroundColor: selected ? colors.primary : colors.backgroundSecondary,
                borderColor: selected ? colors.primary : colors.border,
              },
            ]}
          >
            <ThemedText
              variant="captionBold"
              style={selected ? { color: colors.textInverse } : undefined}
            >
              {relationshipLabel(relationship)}
            </ThemedText>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    // 44pt minimum touch target (WCAG/HIG)
    minHeight: 44,
    justifyContent: 'center',
  },
});
