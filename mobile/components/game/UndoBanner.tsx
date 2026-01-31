/**
 * Floating undo banner for undoing the last action
 */

import React, { useEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
  const [fadeAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      setCountdown(duration);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, duration, fadeAnim]);

  useEffect(() => {
    if (!visible || countdown <= 0) return;

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [visible, countdown]);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      style={[
        styles.container,
        {
          bottom: insets.bottom + spacing.md,
          opacity: fadeAnim,
          transform: [
            {
              translateY: fadeAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [50, 0],
              }),
            },
          ],
        },
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
});
