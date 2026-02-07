/**
 * Floating undo banner for undoing the last action
 */

import React, { useEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface UndoBannerProps {
  visible: boolean;
  message: string;
  onUndo: () => void;
  duration?: number; // Duration in seconds
}

export const UndoBanner: React.FC<UndoBannerProps> = ({
  visible,
  message,
  onUndo,
  duration = 5,
}) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [countdown, setCountdown] = useState(duration);

  // Reanimated shared values
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(50);
  const progressWidth = useSharedValue(1);

  useEffect(() => {
    if (visible) {
      setCountdown(duration);
      opacity.value = withTiming(1, { duration: 200 });
      translateY.value = withTiming(0, { duration: 200 });
      // Progress bar shrinks from 100% to 0% over the duration
      progressWidth.value = 1;
      progressWidth.value = withTiming(0, { duration: duration * 1000 });
    } else {
      opacity.value = withTiming(0, { duration: 200 });
      translateY.value = withTiming(50, { duration: 200 });
    }
  }, [visible, duration]);

  useEffect(() => {
    if (!visible || countdown <= 0) return;

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [visible, countdown]);

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const progressAnimatedStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value * 100}%`,
  }));

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      style={[
        styles.container,
        {
          bottom: insets.bottom + spacing.md,
        },
        containerAnimatedStyle,
      ]}
    >
      <View
        style={[
          styles.banner,
          {
            backgroundColor: colors.backgroundTertiary,
            borderColor: colors.border,
          },
        ]}
      >
        <View style={styles.content}>
          <Ionicons
            name="arrow-undo"
            size={20}
            color={colors.text}
          />
          <ThemedText variant="body" style={styles.message} numberOfLines={1}>
            {message}
          </ThemedText>
        </View>
        <TouchableOpacity
          onPress={onUndo}
          style={[styles.undoButton, { backgroundColor: colors.primary }]}
        >
          <ThemedText variant="captionBold" style={styles.undoText}>
            UNDO ({countdown}s)
          </ThemedText>
        </TouchableOpacity>
        {/* Countdown progress bar */}
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progressBar,
              { backgroundColor: colors.primary },
              progressAnimatedStyle,
            ]}
          />
        </View>
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 1000,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
    overflow: 'hidden',
    flexWrap: 'wrap',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: spacing.sm,
  },
  message: {
    flex: 1,
  },
  undoButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    marginLeft: spacing.sm,
  },
  undoText: {
    color: '#FFFFFF',
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'transparent',
  },
  progressBar: {
    height: 2,
    borderRadius: 1,
  },
});
