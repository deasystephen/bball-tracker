/**
 * Season averages display component with visual bars
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from '../ThemedText';
import { Card } from '../Card';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import type { AggregatedPlayerStats, TeamSeasonStats } from '../../types/stats';
import { useTranslation } from '../../i18n';

interface SeasonAveragesProps {
  stats: AggregatedPlayerStats | TeamSeasonStats;
  maxValues?: {
    points?: number;
    rebounds?: number;
    assists?: number;
  };
}

interface StatBarProps {
  label: string;
  value: number;
  maxValue: number;
  suffix?: string;
}

const StatBar: React.FC<StatBarProps> = ({ label, value, maxValue, suffix = '' }) => {
  const { colors } = useTheme();
  const percentage = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0;

  return (
    <View style={styles.statBarContainer}>
      <View style={styles.statBarHeader}>
        <ThemedText variant="caption" color="textSecondary">
          {label}
        </ThemedText>
        <ThemedText variant="bodyBold">
          {value.toFixed(1)}{suffix}
        </ThemedText>
      </View>
      <View style={[styles.statBarBackground, { backgroundColor: colors.border }]}>
        <View
          style={[
            styles.statBarFill,
            {
              backgroundColor: colors.primary,
              width: `${percentage}%`,
            },
          ]}
        />
      </View>
    </View>
  );
};

export const SeasonAverages: React.FC<SeasonAveragesProps> = ({
  stats,
  maxValues = { points: 30, rebounds: 15, assists: 10 },
}) => {
  const { t } = useTranslation();
  // Both types have these properties, access directly
  const ppg = stats.pointsPerGame;
  const rpg = stats.reboundsPerGame;
  const apg = stats.assistsPerGame;

  return (
    <Card variant="elevated" style={styles.container}>
      <ThemedText variant="h3" heading style={styles.title}>
        {t('stats.seasonAverages')}
      </ThemedText>
      <View style={styles.statsContainer}>
        <StatBar
          label={t('stats.abbr.ppg')}
          value={ppg}
          maxValue={maxValues.points || 30}
        />
        <StatBar
          label={t('stats.abbr.rpg')}
          value={rpg}
          maxValue={maxValues.rebounds || 15}
        />
        <StatBar
          label={t('stats.abbr.apg')}
          value={apg}
          maxValue={maxValues.assists || 10}
        />
      </View>
      {'gamesPlayed' in stats && (
        <ThemedText variant="caption" color="textTertiary" style={styles.gamesPlayed}>
          {t('stats.gamesPlayed', { count: stats.gamesPlayed })}
        </ThemedText>
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  title: {
    marginBottom: spacing.md,
  },
  statsContainer: {
    gap: spacing.sm,
  },
  statBarContainer: {
    marginBottom: spacing.xs,
  },
  statBarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  statBarBackground: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  statBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  gamesPlayed: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
