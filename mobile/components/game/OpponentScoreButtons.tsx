/**
 * Quick score buttons for opponent team
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';

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
        >
          <ThemedText variant="bodyBold" color="textSecondary">
            -1
          </ThemedText>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.button,
            { backgroundColor: colors.warning + '20', borderColor: colors.warning },
          ]}
          onPress={() => onAddPoints(1)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={{ color: colors.warning }}>
            +1
          </ThemedText>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.button,
            { backgroundColor: colors.warning + '40', borderColor: colors.warning },
          ]}
          onPress={() => onAddPoints(2)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={{ color: colors.warning }}>
            +2
          </ThemedText>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.button,
            { backgroundColor: colors.warning, borderColor: colors.warning },
          ]}
          onPress={() => onAddPoints(3)}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <ThemedText variant="bodyBold" style={{ color: '#FFFFFF' }}>
            +3
          </ThemedText>
        </TouchableOpacity>
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
    alignItems: 'center',
  },
  subtractButton: {
    marginRight: spacing.sm,
  },
});
