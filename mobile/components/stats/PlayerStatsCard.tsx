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
import { playerDisplayName } from '../../utils/display-name';
import { useTranslation } from '../../i18n';

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
  const { t } = useTranslation();
  const isAggregated = 'gamesPlayed' in stats;

  const formatPercentage = (value: number) => `${value.toFixed(1)}%`;
  const formatShooting = (made: number, attempted: number) =>
    `${made}-${attempted}`;

  const content = (
    <>
      {/* Player Header */}
      <View style={styles.header}>
        <View style={styles.playerInfo}>
          {stats.jerseyNumber != null && (
            <ThemedText variant="h3" color="primary" style={styles.jerseyNumber}>
              #{stats.jerseyNumber}
            </ThemedText>
          )}
          <View>
            <ThemedText variant="bodyBold" numberOfLines={1}>
              {playerDisplayName(stats)}
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
            {showAverages && isAggregated ? t('stats.abbr.totalPts') : t('stats.abbr.pts')}
          </ThemedText>
        </View>
        <View style={styles.statItem}>
          <ThemedText variant="h2">{stats.rebounds}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {showAverages && isAggregated ? t('stats.abbr.totalReb') : t('stats.abbr.reb')}
          </ThemedText>
        </View>
        <View style={styles.statItem}>
          <ThemedText variant="h2">{stats.assists}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {showAverages && isAggregated ? t('stats.abbr.totalAst') : t('stats.abbr.ast')}
          </ThemedText>
        </View>
      </View>

      {/* Per Game Averages for Aggregated Stats */}
      {showAverages && isAggregated && (
        <View style={[styles.mainStats, styles.averagesRow]}>
          <View style={styles.statItem}>
            <ThemedText variant="bodyBold">{stats.pointsPerGame.toFixed(1)}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.ppg')}</ThemedText>
          </View>
          <View style={styles.statItem}>
            <ThemedText variant="bodyBold">{stats.reboundsPerGame.toFixed(1)}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.rpg')}</ThemedText>
          </View>
          <View style={styles.statItem}>
            <ThemedText variant="bodyBold">{stats.assistsPerGame.toFixed(1)}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.apg')}</ThemedText>
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
              <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.stl')}</ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.blocks}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.blk')}</ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.turnovers}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.to')}</ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">{stats.fouls}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.pf')}</ThemedText>
            </View>
          </View>

          {/* Shooting Stats */}
          <View style={styles.detailRow}>
            <View style={styles.detailItem}>
              <ThemedText variant="body">
                {formatShooting(stats.fieldGoalsMade, stats.fieldGoalsAttempted)}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {t('stats.shootingWithPct', { label: t('stats.abbr.fg'), pct: formatPercentage(stats.fieldGoalPercentage) })}
              </ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">
                {formatShooting(stats.threePointersMade, stats.threePointersAttempted)}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {t('stats.shootingWithPct', { label: t('stats.abbr.threes'), pct: formatPercentage(stats.threePointPercentage) })}
              </ThemedText>
            </View>
            <View style={styles.detailItem}>
              <ThemedText variant="body">
                {formatShooting(stats.freeThrowsMade, stats.freeThrowsAttempted)}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {t('stats.shootingWithPct', { label: t('stats.abbr.ft'), pct: formatPercentage(stats.freeThrowPercentage) })}
              </ThemedText>
            </View>
          </View>

          {/* Efficiency for aggregated stats */}
          {isAggregated && (
            <View style={styles.efficiencyRow}>
              <ThemedText variant="caption" color="textSecondary">
                {t('stats.efficiencyAndGames', { efficiency: stats.efficiency.toFixed(1), games: stats.gamesPlayed })}
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
        <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button">
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
