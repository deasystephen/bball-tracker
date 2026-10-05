/**
 * Quick score buttons for opponent team
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { MIN_TOUCH_TARGET } from '../../utils/touch-target';

/** The fill deepens with the points: a light tint, a stronger tint, solid. */
const ADD_BUTTONS = [
  { points: 1, tint: '20' },
  { points: 2, tint: '40' },
  { points: 3, tint: null },
] as const;

interface OpponentScoreButtonsProps {
  onAddPoints: (points: number) => void;
  onSubtractPoint: () => void;
  disabled?: boolean;
}

export const OpponentScoreButtons: React.FC<OpponentScoreButtonsProps> = ({
  onAddPoints,
  onSubtractPoint,
  disabled = false,
}) => {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
        Opponent Score
      </ThemedText>
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[
            styles.button,
            styles.subtractButton,
            { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
          ]}
          onPress={onSubtractPoint}
          disabled={disabled}
          activeOpacity={0.7}
          // `disabled` already sets accessibilityState.disabled (#773).
          accessibilityRole="button"
          accessibilityLabel="Subtract 1 from opponent score"
        >
          <ThemedText variant="bodyBold" color="textSecondary">
            -1
          </ThemedText>
        </TouchableOpacity>

        {ADD_BUTTONS.map(({ points, tint }) => {
          const solid = tint === null;
          return (
            <TouchableOpacity
              key={points}
              style={[
                styles.button,
                {
                  backgroundColor: solid ? colors.warning : colors.warning + tint,
                  borderColor: colors.warning,
                },
              ]}
              onPress={() => onAddPoints(points)}
              disabled={disabled}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Add ${points} to opponent score`}
            >
              <ThemedText variant="bodyBold" style={{ color: solid ? '#FFFFFF' : colors.warning }}>
                {`+${points}`}
              </ThemedText>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  label: {
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 60,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtractButton: {
    marginRight: spacing.sm,
  },
});
