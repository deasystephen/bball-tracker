/**
 * Team stats dashboard - coach view with roster and season stats
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  ListItem,
  LoadingSpinner,
  ErrorState,
  SortPills,
} from '../../../components';
import { SeasonAverages, PlayerStatsCard, SeasonRecord } from '../../../components/stats';
import { PrintButton } from '../../../components/PrintButton';
import { useTeamSeasonStats, useTeamRosterStats } from '../../../hooks/useStats';
import { useTeam } from '../../../hooks/useTeams';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding, isWeb } from '../../../utils/responsive';
import { getResultColor, resultLetter } from '../../../utils/game-result';
import { useTranslation } from '../../../i18n';
import { useGoBack } from '../../../hooks/useGoBack';
import { BackButton } from '../../../components/BackButton';
import { formatNumericDate } from '../../../utils/format-date';

type SortKey = 'ppg' | 'rpg' | 'apg' | 'efficiency';

export default function TeamStatsScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/teams');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [sortBy, setSortBy] = useState<SortKey>('ppg');

  const { data: team, isLoading: teamLoading } = useTeam(id);
  const { data: seasonStats, isLoading: seasonLoading, error: seasonError, refetch: refetchSeason } = useTeamSeasonStats(id);
  const { data: rosterStats, isLoading: rosterLoading, error: rosterError, refetch: refetchRoster } = useTeamRosterStats(id);

  const isLoading = teamLoading || seasonLoading || rosterLoading;
  const error = seasonError || rosterError;

  const sortedRoster = React.useMemo(() => {
    if (!rosterStats) return [];
    return [...rosterStats].sort((a, b) => {
      switch (sortBy) {
        case 'ppg':
          return b.pointsPerGame - a.pointsPerGame;
        case 'rpg':
          return b.reboundsPerGame - a.reboundsPerGame;
        case 'apg':
          return b.assistsPerGame - a.assistsPerGame;
        case 'efficiency':
          return b.efficiency - a.efficiency;
        default:
          return 0;
      }
    });
  }, [rosterStats, sortBy]);

  const handleRefresh = () => {
    refetchSeason();
    refetchRoster();
  };

  if (isLoading) {
    return <LoadingSpinner message={t('stats.loadingTeamStats')} fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('stats.loadFailed')}
        onRetry={handleRefresh}
        onBack={goBack}
      />
    );
  }

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'ppg', label: t('stats.abbr.ppg') },
    { key: 'rpg', label: t('stats.abbr.rpg') },
    { key: 'apg', label: t('stats.abbr.apg') },
    { key: 'efficiency', label: t('stats.abbr.eff') },
  ];

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header */}
      <View
        style={[
          styles.topHeader,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: padding,
            paddingBottom: spacing.md,
            borderBottomColor: colors.border,
          },
        ]}
        data-hide-on-print="true"
      >
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading numberOfLines={1}>
            {t('stats.teamStatsTitle', { team: team?.name || t('stats.teamFallback') })}
          </ThemedText>
        </View>
        {isWeb && <PrintButton />}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Season Record */}
        {seasonStats && (
          <Card variant="elevated" style={styles.recordCard}>
            <View style={styles.recordHeader}>
              <ThemedText variant="h3" heading>{t('stats.seasonRecord')}</ThemedText>
              <SeasonRecord
                wins={seasonStats.wins}
                losses={seasonStats.losses}
                ties={seasonStats.ties}
                style={styles.record}
                testID="team-stats-record"
              />
            </View>
            <ThemedText variant="caption" color="textSecondary" style={styles.gamesPlayed}>
              {t('stats.gamesPlayed', { count: seasonStats.gamesPlayed })}
            </ThemedText>
          </Card>
        )}

        {/* Season Averages */}
        {seasonStats && (
          <SeasonAverages stats={seasonStats} />
        )}

        {/* Shooting Percentages */}
        {seasonStats && (
          <Card variant="default" style={styles.shootingCard}>
            <ThemedText variant="h3" heading style={styles.sectionTitle}>
              {t('stats.shootingPercentages')}
            </ThemedText>
            <View style={styles.shootingRow}>
              <View style={styles.shootingItem}>
                <ThemedText variant="h2" heading={false} /* shooting percentage, a value */>
                  {seasonStats.fieldGoalPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.fgPct')}</ThemedText>
              </View>
              <View style={styles.shootingItem}>
                <ThemedText variant="h2" heading={false} /* shooting percentage, a value */>
                  {seasonStats.threePointPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.threePct')}</ThemedText>
              </View>
              <View style={styles.shootingItem}>
                <ThemedText variant="h2" heading={false} /* shooting percentage, a value */>
                  {seasonStats.freeThrowPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">{t('stats.abbr.ftPct')}</ThemedText>
              </View>
            </View>
          </Card>
        )}

        {/* Recent Games */}
        {seasonStats && seasonStats.recentGames.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" heading style={styles.sectionTitle}>
              {t('stats.recentGames')}
            </ThemedText>
            <Card variant="default">
              {seasonStats.recentGames.slice(0, 5).map((game) => (
                <ListItem
                  key={game.id}
                  title={game.opponent}
                  subtitle={formatNumericDate(game.date)}
                  onPress={() => router.push(`/games/${game.id}/stats`)}
                  rightElement={
                    <View style={styles.gameResult}>
                      <ThemedText
                        variant="bodyBold"
                        style={{ color: getResultColor(game.result, colors) }}
                      >
                        {resultLetter(t, game.result)}
                      </ThemedText>
                      <ThemedText variant="caption" color="textSecondary">
                        {game.homeScore}-{game.awayScore}
                      </ThemedText>
                    </View>
                  }
                />
              ))}
            </Card>
          </View>
        )}

        {/* Roster Stats */}
        {sortedRoster.length > 0 && (
          <View style={styles.section}>
            <View style={styles.rosterHeader}>
              <ThemedText variant="h3" heading>{t('stats.rosterStats')}</ThemedText>
              <SortPills options={sortOptions} selected={sortBy} onSelect={setSortBy} />
            </View>

            {sortedRoster.map((player) => (
              <PlayerStatsCard
                key={player.playerId}
                stats={player}
                showAverages={true}
                compact={true}
                onPress={() => router.push(`/players/${player.playerId}/stats`)}
              />
            ))}
          </View>
        )}

        {/* Empty State */}
        {(!seasonStats || seasonStats.gamesPlayed === 0) && (
          <Card variant="default" style={styles.emptyCard}>
            <Ionicons name="stats-chart-outline" size={48} color={colors.textTertiary} />
            <ThemedText variant="body" color="textSecondary" style={styles.emptyText}>
              {t('stats.noGamesYet')}
            </ThemedText>
          </Card>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  recordCard: {
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  recordHeader: {
    alignItems: 'center',
  },
  record: {
    marginTop: spacing.sm,
  },
  gamesPlayed: {
    marginTop: spacing.sm,
  },
  shootingCard: {
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  shootingRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: spacing.md,
  },
  shootingItem: {
    alignItems: 'center',
    flex: 1,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionTitle: {
    marginBottom: spacing.md,
  },
  gameResult: {
    alignItems: 'flex-end',
  },
  rosterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  emptyCard: {
    alignItems: 'center',
    padding: spacing.xl,
    marginTop: spacing.xl,
  },
  emptyText: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
