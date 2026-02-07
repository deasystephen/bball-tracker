/**
 * Skeleton loading placeholders with shimmer animation
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  interpolate,
  Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme/spacing';
import { borderRadius } from '../theme/border-radius';

interface SkeletonBoxProps {
  width: number | `${number}%`;
  height: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export const SkeletonBox: React.FC<SkeletonBoxProps> = ({
  width,
  height,
  borderRadius: radius = borderRadius.sm,
  style,
}) => {
  const { colors } = useTheme();
  const shimmer = useSharedValue(0);

  useEffect(() => {
    shimmer.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
  }, [shimmer]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(shimmer.value, [0, 1], [-200, 200]),
      },
    ],
  }));

  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: colors.backgroundTertiary,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
        <LinearGradient
          colors={[
            'transparent',
            colors.backgroundSecondary + '60',
            'transparent',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
};

export const HomeSkeleton: React.FC = () => {
  return (
    <View style={styles.container}>
      {/* Greeting bar */}
      <SkeletonBox width="60%" height={28} style={styles.item} />
      <SkeletonBox width="40%" height={16} style={styles.item} />

      {/* Hero card */}
      <SkeletonBox
        width="100%"
        height={180}
        borderRadius={borderRadius.lg}
        style={styles.heroCard}
      />

      {/* Small cards row */}
      <View style={styles.row}>
        <SkeletonBox width={110} height={100} borderRadius={borderRadius.md} />
        <SkeletonBox width={110} height={100} borderRadius={borderRadius.md} />
        <SkeletonBox width={110} height={100} borderRadius={borderRadius.md} />
      </View>
    </View>
  );
};

export const GamesSkeleton: React.FC = () => {
  return (
    <View style={styles.container}>
      {[0, 1, 2, 3].map((i) => (
        <SkeletonBox
          key={i}
          width="100%"
          height={120}
          borderRadius={borderRadius.lg}
          style={styles.item}
        />
      ))}
    </View>
  );
};

export const StatsSkeleton: React.FC = () => {
  return (
    <View style={styles.container}>
      {/* Header */}
      <SkeletonBox width="50%" height={24} style={styles.item} />

      {/* Stat circles row */}
      <View style={styles.circlesRow}>
        <SkeletonBox width={72} height={72} borderRadius={36} />
        <SkeletonBox width={72} height={72} borderRadius={36} />
        <SkeletonBox width={72} height={72} borderRadius={36} />
      </View>

      {/* Stat cards */}
      {[0, 1, 2].map((i) => (
        <SkeletonBox
          key={i}
          width="100%"
          height={80}
          borderRadius={borderRadius.lg}
          style={styles.item}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
  },
  item: {
    marginBottom: spacing.md,
  },
  heroCard: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  circlesRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: spacing.lg,
  },
});
