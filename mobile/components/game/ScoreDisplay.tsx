/**
 * Live score display header for game tracking
 */

import React, { useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
} from 'react-native-reanimated';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing, typography } from '../../theme';
import type { ColorScheme } from '../../theme/colors';

interface ScoreDisplayProps {
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  onBack?: () => void;
  onEndGame?: () => void;
  showEndButton?: boolean;
}

export const ScoreDisplay: React.FC<ScoreDisplayProps> = ({
  homeTeamName,
  awayTeamName,
  homeScore,
  awayScore,
  onBack,
  onEndGame,
  showEndButton = true,
}) => {
  const { colors, colorScheme } = useTheme();

  const gradientColors = colorScheme === 'dark'
    ? ['#0D1117', '#161B22'] as const
    : ['#1A3A5C', '#0F2540'] as const;

  // Score pop animation
  const homeScoreScale = useSharedValue(1);
  const awayScoreScale = useSharedValue(1);

  useEffect(() => {
    homeScoreScale.value = withTiming(1.15, { duration: 120 }, () => {
      homeScoreScale.value = withSpring(1, { damping: 12, stiffness: 200 });
    });
  }, [homeScore]);

  useEffect(() => {
    awayScoreScale.value = withTiming(1.15, { duration: 120 }, () => {
      awayScoreScale.value = withSpring(1, { damping: 12, stiffness: 200 });
    });
  }, [awayScore]);

  // Live dot pulse
  const liveDotOpacity = useSharedValue(1);

  useEffect(() => {
    liveDotOpacity.value = withRepeat(
      withTiming(0.3, { duration: 1500 }),
      -1,
      true
    );
  }, []);

  const homeScoreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: homeScoreScale.value }],
  }));

  const awayScoreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: awayScoreScale.value }],
  }));

  const liveDotAnimatedStyle = useAnimatedStyle(() => ({
    opacity: liveDotOpacity.value,
  }));

  return (
    <LinearGradient
      colors={gradientColors}
      style={styles.container}
    >
      <View style={styles.topRow}>
        {onBack && (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        )}
        <View style={styles.titleContainer}>
          <View style={[styles.liveBadge, { backgroundColor: colors.success }]}>
            <Animated.View style={[styles.liveDot, liveDotAnimatedStyle]} />
            <ThemedText variant="caption" style={styles.liveText}>
              LIVE
            </ThemedText>
          </View>
        </View>
        {showEndButton && onEndGame ? (
          <TouchableOpacity
            onPress={onEndGame}
            style={[styles.endButton, { backgroundColor: colors.error + '20' }]}
            accessibilityRole="button"
            accessibilityLabel="End game"
          >
            <ThemedText
              variant="captionBold"
              style={{ color: colors.error }}
            >
              End
            </ThemedText>
          </TouchableOpacity>
        ) : (
          <View style={styles.placeholder} />
        )}
      </View>

      <View
        style={styles.scoreRow}
        accessibilityLabel={`Score: ${homeTeamName} ${homeScore}, ${awayTeamName} ${awayScore}`}
      >
        <View style={styles.teamScore}>
          <ThemedText
            variant="caption"
            numberOfLines={1}
            style={styles.teamName}
          >
            {homeTeamName}
          </ThemedText>
          <Animated.View style={homeScoreAnimatedStyle}>
            <ThemedText variant="body" style={styles.score}>
              {homeScore}
            </ThemedText>
          </Animated.View>
        </View>

        <View style={styles.divider}>
          <View style={styles.verticalLine} />
        </View>

        <View style={[styles.teamScore, styles.awayTeam]}>
          <ThemedText
            variant="caption"
            numberOfLines={1}
            style={styles.teamName}
          >
            {awayTeamName}
          </ThemedText>
          <Animated.View style={awayScoreAnimatedStyle}>
            <ThemedText variant="body" style={styles.score}>
              {awayScore}
            </ThemedText>
          </Animated.View>
        </View>
      </View>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  backButton: {
    padding: spacing.sm,
    marginLeft: -spacing.xs,
  },
  titleContainer: {
    alignItems: 'center',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    gap: spacing.xs,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  liveText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  endButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
  },
  placeholder: {
    width: 50,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamScore: {
    flex: 1,
    alignItems: 'center',
  },
  awayTeam: {
    alignItems: 'center',
  },
  teamName: {
    textAlign: 'center',
    marginBottom: spacing.xs,
    color: '#FFFFFF',
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  score: {
    ...typography.displaySmall,
    color: '#FFFFFF',
    lineHeight: 56,
  },
  divider: {
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verticalLine: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
});
