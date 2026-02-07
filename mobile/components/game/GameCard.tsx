/**
 * Game list item card component
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '../ThemedText';
import { Card } from '../Card';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import type { Game, GameStatus } from '../../types/game';

interface GameCardProps {
  game: Game;
  onPress: () => void;
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

const GameCardInner: React.FC<GameCardProps> = ({ game, onPress }) => {
  const { colors } = useTheme();
  const statusColor = getStatusColor(game.status, colors);
  const isLive = game.status === 'IN_PROGRESS';

  return (
    <Card variant="elevated" onPress={onPress} style={styles.card}>
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

        {/* Arrow */}
        <View style={styles.arrowContainer}>
          <Ionicons
            name="chevron-forward"
            size={20}
            color={colors.textTertiary}
          />
        </View>
      </View>
    </Card>
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
  arrowContainer: {
    position: 'absolute',
    right: 0,
    top: '50%',
    marginTop: -10,
  },
});
