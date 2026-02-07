/**
 * 2x2 grid of shot buttons for stat tracking
 */

import React, { useCallback } from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';

interface ShotButtonsProps {
  onShot: (points: 2 | 3, made: boolean) => void;
  disabled?: boolean;
}

const BUTTON_HEIGHT = 60;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ShotButtonProps {
  points: 2 | 3;
  made: boolean;
  color: string;
  disabled: boolean;
  width: number;
  onPress: (points: 2 | 3, made: boolean) => void;
}

const ShotButton: React.FC<ShotButtonProps> = ({ points, made, color, disabled, width, onPress }) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withTiming(0.95, { duration: 50 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 300 });
  };

  const handlePress = () => {
    if (disabled) return;
    Haptics.impactAsync(
      made ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
    );
    onPress(points, made);
  };

  const label = made ? 'MADE' : 'MISS';
  const accessibilityLabel = `${points}-point shot ${made ? 'made' : 'missed'}`;

  return (
    <AnimatedPressable
      style={[
        animatedStyle,
        styles.button,
        {
          backgroundColor: disabled ? 'rgba(128,128,128,0.3)' : color,
          width,
          height: BUTTON_HEIGHT,
        },
      ]}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <ThemedText variant="body" style={styles.pointsText}>
        {points}PT
      </ThemedText>
      <ThemedText variant="caption" style={styles.madeText}>
        {label}
      </ThemedText>
    </AnimatedPressable>
  );
};

/**
 * Memoized to prevent re-renders when parent state changes (e.g., score updates).
 */
export const ShotButtons: React.FC<ShotButtonsProps> = React.memo(({
  onShot,
  disabled = false,
}) => {
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const buttonWidth = (windowWidth - spacing.md * 3) / 2;

  const handlePress = useCallback((points: 2 | 3, made: boolean) => {
    if (!disabled) {
      onShot(points, made);
    }
  }, [disabled, onShot]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <ShotButton
          points={2}
          made={true}
          color={colors.success}
          disabled={disabled}
          width={buttonWidth}
          onPress={handlePress}
        />
        <ShotButton
          points={2}
          made={false}
          color={colors.error}
          disabled={disabled}
          width={buttonWidth}
          onPress={handlePress}
        />
      </View>

      <View style={styles.row}>
        <ShotButton
          points={3}
          made={true}
          color={colors.success}
          disabled={disabled}
          width={buttonWidth}
          onPress={handlePress}
        />
        <ShotButton
          points={3}
          made={false}
          color={colors.error}
          disabled={disabled}
          width={buttonWidth}
          onPress={handlePress}
        />
      </View>

      {disabled && (
        <View style={styles.disabledOverlay}>
          <ThemedText variant="caption" color="textTertiary">
            Select a player first
          </ThemedText>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    position: 'relative',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  button: {
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pointsText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 20,
    lineHeight: 24,
  },
  madeText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 12,
    lineHeight: 16,
    opacity: 0.85,
  },
  disabledOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.1)',
    borderRadius: 14,
    margin: spacing.md,
  },
});
