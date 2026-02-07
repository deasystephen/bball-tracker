/**
 * Game list item card component
 */

import React, { useEffect } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
} from 'react-native-reanimated';
import { MotiView } from 'moti';
import { ThemedText } from '../ThemedText';
import { Card } from '../Card';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import type { Game, GameStatus } from '../../types/game';

interface GameCardProps {
  game: Game;
  onPress: () => void;
  index?: number;
}

const getStatusColor = (
  status: GameStatus,
  colors: ReturnType<typeof useTheme>['colors']
): string => {
  switch (status) {
    case 'SCHEDULED':
      return colors.info;
    case 'IN_PROGRESS':
      return colors.success;
    case 'FINISHED':
      return colors.textTertiary;
    case 'CANCELLED':
      return colors.error;
    default:
      return colors.textSecondary;
  }
};

const getStatusLabel = (status: GameStatus): string => {
  switch (status) {
    case 'SCHEDULED':
      return 'Scheduled';
    case 'IN_PROGRESS':
      return 'Live';
    case 'FINISHED':
      return 'Final';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status;
  }
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
};

const formatTime = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
};

const GameCardInner: React.FC<GameCardProps> = ({ game, onPress, index = 0 }) => {
  const { colors } = useTheme();
  const statusColor = getStatusColor(game.status, colors);
  const isLive = game.status === 'IN_PROGRESS';

  // Press depth animation
  const scale = useSharedValue(1);

  // Live border pulse
  const liveBorderOpacity = useSharedValue(0.6);

  useEffect(() => {
    if (isLive) {
      liveBorderOpacity.value = withRepeat(
        withTiming(1, { duration: 1500 }),
        -1,
        true
      );
    }
  }, [isLive]);

  const pressAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const liveBorderStyle = useAnimatedStyle(() => ({
    borderLeftWidth: isLive ? 3 : 0,
    borderLeftColor: isLive ? colors.accent : 'transparent',
    opacity: isLive ? liveBorderOpacity.value : 1,
  }));

  const handlePressIn = () => {
    scale.value = withTiming(0.98, { duration: 100 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 300 });
  };

  return (
    <MotiView
      from={{ opacity: 0, translateY: 20 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{
        type: 'timing',
        duration: 350,
        delay: index * 80,
      }}
    >
      <Animated.View style={[pressAnimatedStyle]}>
        <Pressable
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
        >
          <Animated.View style={[liveBorderStyle]}>
            <Card variant="elevated" style={styles.card}>
              <View style={styles.container}>
                {/* Status Badge */}
                <View style={styles.header}>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: statusColor + '20' },
                    ]}
                  >
                    {isLive && (
                      <View style={[styles.liveDot, { backgroundColor: statusColor }]} />
                    )}
                    <ThemedText
                      variant="caption"
                      style={[styles.statusText, { color: statusColor }]}
                    >
                      {getStatusLabel(game.status)}
                    </ThemedText>
                  </View>
                  <View style={styles.dateTime}>
                    <ThemedText variant="caption" color="textSecondary">
                      {formatDate(game.date)}
                    </ThemedText>
                    <ThemedText variant="caption" color="textTertiary">
                      {formatTime(game.date)}
                    </ThemedText>
                  </View>
                </View>

                {/* Teams and Score */}
                <View style={styles.matchup}>
                  <View style={styles.teamSection}>
                    <ThemedText variant="bodyBold" numberOfLines={1}>
                      {game.team?.name || 'Your Team'}
                    </ThemedText>
                    {(game.status === 'IN_PROGRESS' || game.status === 'FINISHED') && (
                      <ThemedText variant="h2" style={styles.score}>
                        {game.homeScore}
                      </ThemedText>
                    )}
                  </View>

                  <View style={styles.vsContainer}>
                    <ThemedText variant="caption" color="textTertiary">
                      vs
                    </ThemedText>
                  </View>

                  <View style={[styles.teamSection, styles.teamSectionRight]}>
                    <ThemedText
                      variant="bodyBold"
                      numberOfLines={1}
                      style={styles.opponentName}
                    >
                      {game.opponent}
                    </ThemedText>
                    {(game.status === 'IN_PROGRESS' || game.status === 'FINISHED') && (
                      <ThemedText variant="h2" style={styles.score}>
                        {game.awayScore}
                      </ThemedText>
                    )}
                  </View>
                </View>
              </View>
            </Card>
          </Animated.View>
        </Pressable>
      </Animated.View>
    </MotiView>
  );
};

/**
 * Memoized GameCard to prevent unnecessary re-renders in FlatList.
 * Only re-renders when the game data or onPress handler changes.
 */
export const GameCard = React.memo(GameCardInner);

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.sm,
  },
  container: {
    position: 'relative',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  statusBadge: {
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
  },
  statusText: {
    fontWeight: '600',
  },
  dateTime: {
    alignItems: 'flex-end',
  },
  matchup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  teamSection: {
    flex: 1,
    alignItems: 'flex-start',
  },
  teamSectionRight: {
    alignItems: 'flex-end',
  },
  opponentName: {
    textAlign: 'right',
  },
  vsContainer: {
    paddingHorizontal: spacing.md,
  },
  score: {
    marginTop: spacing.xs,
  },
});
