/**
 * Additional stat buttons for rebounds, steals, blocks, assists
 */

import React, { useMemo, useCallback } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface StatButtonItemProps {
  stat: StatButtonConfig;
  disabled: boolean;
  bgColor: string;
  borderColor: string;
  textColor: string;
  onPress: () => void;
}

const StatButtonItem: React.FC<StatButtonItemProps> = ({
  stat,
  disabled,
  bgColor,
  borderColor,
  textColor,
  onPress,
}) => {
  const bgOpacity = useSharedValue(0);
  const iconScale = useSharedValue(1);

  const animatedBgStyle = useAnimatedStyle(() => ({
    backgroundColor: bgColor,
    opacity: 1 - bgOpacity.value * 0.7,
  }));

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const handlePress = () => {
    if (disabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Color pulse: briefly fill then fade
    bgOpacity.value = withSequence(
      withTiming(1, { duration: 100 }),
      withTiming(0, { duration: 300 })
    );

    // Icon scale pulse
    iconScale.value = withSequence(
      withTiming(1.2, { duration: 100 }),
      withTiming(1, { duration: 200 })
    );

    onPress();
  };

  return (
    <AnimatedPressable
      style={[
        styles.button,
        {
          borderColor,
        },
        animatedBgStyle,
      ]}
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Record ${stat.label}`}
      accessibilityState={{ disabled }}
    >
      <Animated.View style={iconAnimatedStyle}>
        <Ionicons
          name={stat.icon}
          size={20}
          color={textColor}
        />
      </Animated.View>
      <ThemedText
        variant="captionBold"
        style={[
          styles.buttonText,
          { color: textColor },
        ]}
      >
        {stat.shortLabel}
      </ThemedText>
    </AnimatedPressable>
  );
};

/**
 * Memoized to prevent re-renders during score updates on tracking screen.
 */
export const StatButtons: React.FC<StatButtonsProps> = React.memo(({
  onStat,
  disabled = false,
}) => {
  const { colors } = useTheme();

  const stats: StatButtonConfig[] = useMemo(() => [
    { type: 'OREB', label: 'Off Reb', shortLabel: 'OREB', icon: 'arrow-up-circle', color: colors.success },
    { type: 'DREB', label: 'Def Reb', shortLabel: 'DREB', icon: 'arrow-down-circle', color: colors.info },
    { type: 'AST', label: 'Assist', shortLabel: 'AST', icon: 'people', color: colors.primary },
    { type: 'STL', label: 'Steal', shortLabel: 'STL', icon: 'hand-left', color: colors.warning },
    { type: 'BLK', label: 'Block', shortLabel: 'BLK', icon: 'stop-circle', color: colors.error },
  ], [colors]);

  return (
    <View style={styles.container}>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
        Other Stats
      </ThemedText>
      <View style={styles.buttonGrid}>
        {stats.map((stat) => (
          <StatButtonItem
            key={stat.type}
            stat={stat}
            disabled={disabled}
            bgColor={disabled ? colors.backgroundSecondary : stat.color + '15'}
            borderColor={disabled ? colors.border : stat.color}
            textColor={disabled ? colors.textTertiary : stat.color}
            onPress={() => onStat(stat.type)}
          />
        ))}
      </View>
      {disabled && (
        <ThemedText variant="caption" color="textTertiary" style={styles.hint}>
          Select a player first
        </ThemedText>
      )}
    </View>
  );
});

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
    minHeight: 44,
  },
  buttonText: {
    fontWeight: '600',
  },
  hint: {
    marginTop: spacing.sm,
    textAlign: 'center',
  },
});
