/**
 * Player stats card component
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { ThemedText } from '../ThemedText';
import { Card } from '../Card';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { Ionicons } from '@expo/vector-icons';
import type { PlayerGameStats, AggregatedPlayerStats } from '../../types/stats';

interface PlayerStatsCardProps {
  stats: PlayerGameStats | AggregatedPlayerStats;
  onPress?: () => void;
  showAverages?: boolean;
  compact?: boolean;
}

export const PlayerStatsCard: React.FC<PlayerStatsCardProps> = ({
  stats,
  onPress,
  showAverages = false,
  compact = false,
}) => {
  const { colors } = useTheme();
  const isAggregated = 'gamesPlayed' in stats;

  const formatPercentage = (value: number) => `${value.toFixed(1)}%`;
  const formatShooting = (made: number, attempted: number) =>
    `${made}-${attempted}`;

  const content = (
    <>
      {/* Player Header */}
      <View style={styles.header}>
        <View style={styles.playerInfo}>
          {stats.jerseyNumber !== undefined && (
            <ThemedText variant="h3" color="primary" style={styles.jerseyNumber}>
              #{stats.jerseyNumber}
            </ThemedText>
          )}
          <View>
            <ThemedText variant="bodyBold" numberOfLines={1}>
              {stats.playerName}
            </ThemedText>
            {stats.position && (
              <ThemedText variant="caption" color="textSecondary">
                {stats.position}
              </ThemedText>
            )}
          </View>
        </View>
        {onPress && (
          <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
        )}
      </View>

      {/* Main Stats */}
      <View style={styles.mainStats}>
        <View style={styles.statItem}>
          <ThemedText variant="h2">{stats.points}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {showAverages && isAggregated ? 'Total PTS' : 'PTS'}
          </ThemedText>
        </View>
        <View style={styles.statItem}>
          <ThemedText variant="h2">{stats.rebounds}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {showAverages && isAggregated ? 'Total REB' : 'REB'}
          </ThemedText>
        </View>
        <View style={styles.statItem}>
          <ThemedText variant="h2">{stats.assists}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {showAverages && isAggregated ? 'Total AST' : 'AST'}
          </ThemedText>
        </View>
      </View>

      {/* Per Game Averages for Aggregated Stats */}
      {showAverages && isAggregated && (
        <View style={[styles.mainStats, styles.averagesRow]}>
          <View style={styles.statItem}>
            <ThemedText variant="bodyBold">{stats.pointsPerGame.toFixed(1)}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">PPG</ThemedText>
          </View>
          <View style={styles.statItem}>
            <ThemedText variant="bodyBold">{stats.reboundsPerGame.toFixed(1)}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">RPG</ThemedText>
          </View>
          <View style={styles.statItem}>
            <ThemedText variant="bodyBold">{stats.assistsPerGame.toFixed(1)}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">APG</ThemedText>
          </View>
        </View>
      )}

      {/* Detailed Stats (non-compact mode) */}
      {!compact && (
        <>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          {/* Defensive Stats */}
          <View style={styles.detailRow}>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.steals}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">STL</ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.blocks}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">BLK</ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.turnovers}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">TO</ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.fouls}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">PF</ThemedText>
            </View>
          </View>

          {/* Shooting Stats */}
          <View style={styles.detailRow}>
            <View style={styles.detailItem}>
              <ThemedText variant="body">
                {formatShooting(stats.fieldGoalsMade, stats.fieldGoalsAttempted)}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                FG ({formatPercentage(stats.fieldGoalPercentage)})
              </ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">
                {formatShooting(stats.threePointersMade, stats.threePointersAttempted)}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                3P ({formatPercentage(stats.threePointPercentage)})
              </ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">
                {formatShooting(stats.freeThrowsMade, stats.freeThrowsAttempted)}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                FT ({formatPercentage(stats.freeThrowPercentage)})
              </ThemedText>
            </View>
          </View>

          {/* Efficiency for aggregated stats */}
          {isAggregated && (
            <View style={styles.efficiencyRow}>
              <ThemedText variant="caption" color="textSecondary">
                Efficiency: {stats.efficiency.toFixed(1)} | Games: {stats.gamesPlayed}
              </ThemedText>
            </View>
          )}
        </>
      )}
    </>
  );

  if (onPress) {
    return (
      <Card variant="elevated" style={styles.container}>
        <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
          {content}
        </TouchableOpacity>
      </Card>
    );
  }

  return (
    <Card variant="elevated" style={styles.container}>
      {content}
    </Card>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  playerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  jerseyNumber: {
    marginRight: spacing.sm,
  },
  mainStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: spacing.sm,
  },
  averagesRow: {
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128, 128, 128, 0.2)',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.md,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: spacing.sm,
  },
  detailItem: {
    alignItems: 'center',
    flex: 1,
  },
  efficiencyRow: {
    alignItems: 'center',
    marginTop: spacing.sm,
  },
});
