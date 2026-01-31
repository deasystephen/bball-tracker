/**
 * Additional stat buttons for rebounds, steals, blocks, assists
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';

export type StatType = 'OREB' | 'DREB' | 'STL' | 'BLK' | 'AST';

interface StatButtonsProps {
  onStat: (statType: StatType) => void;
  disabled?: boolean;
}

interface StatButtonConfig {
  type: StatType;
  label: string;
  shortLabel: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}

export const StatButtons: React.FC<StatButtonsProps> = ({
  onStat,
  disabled = false,
}) => {
  const { colors } = useTheme();

  const stats: StatButtonConfig[] = [
    { type: 'OREB', label: 'Off Reb', shortLabel: 'OREB', icon: 'arrow-up-circle', color: colors.success },
    { type: 'DREB', label: 'Def Reb', shortLabel: 'DREB', icon: 'arrow-down-circle', color: colors.info },
    { type: 'AST', label: 'Assist', shortLabel: 'AST', icon: 'people', color: colors.primary },
    { type: 'STL', label: 'Steal', shortLabel: 'STL', icon: 'hand-left', color: colors.warning },
    { type: 'BLK', label: 'Block', shortLabel: 'BLK', icon: 'stop-circle', color: colors.error },
  ];

  return (
    <View style={styles.container}>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
        Other Stats
      </ThemedText>
      <View style={styles.buttonGrid}>
        {stats.map((stat) => (
          <TouchableOpacity
            key={stat.type}
            style={[
              styles.button,
              {
                backgroundColor: disabled ? colors.backgroundSecondary : stat.color + '15',
                borderColor: disabled ? colors.border : stat.color,
              },
            ]}
            onPress={() => onStat(stat.type)}
            disabled={disabled}
            activeOpacity={0.7}
          >
            <Ionicons
              name={stat.icon}
              size={20}
              color={disabled ? colors.textTertiary : stat.color}
            />
            <ThemedText
              variant="captionBold"
              style={[
                styles.buttonText,
                { color: disabled ? colors.textTertiary : stat.color },
              ]}
            >
              {stat.shortLabel}
            </ThemedText>
          </TouchableOpacity>
        ))}
      </View>
      {disabled && (
        <ThemedText variant="caption" color="textTertiary" style={styles.hint}>
          Select a player first
        </ThemedText>
      )}
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
  },
  buttonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 80,
  },
  buttonText: {
    fontWeight: '600',
  },
  hint: {
    marginTop: spacing.sm,
    textAlign: 'center',
  },
});
