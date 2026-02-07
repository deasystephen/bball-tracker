/**
 * Team stats dashboard - coach view with roster and season stats
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
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
} from '../../../components';
import { SeasonAverages, PlayerStatsCard } from '../../../components/stats';
import { PrintButton } from '../../../components/PrintButton';
import { useTeamSeasonStats, useTeamRosterStats } from '../../../hooks/useStats';
import { useTeam } from '../../../hooks/useTeams';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding, isWeb } from '../../../utils/responsive';
import type { AggregatedPlayerStats } from '../../../types/stats';

type SortKey = 'ppg' | 'rpg' | 'apg' | 'efficiency';

export default function TeamStatsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
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
    return <LoadingSpinner message="Loading team stats..." fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load stats'}
        onRetry={handleRefresh}
      />
    );
  }

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'ppg', label: 'PPG' },
    { key: 'rpg', label: 'RPG' },
    { key: 'apg', label: 'APG' },
    { key: 'efficiency', label: 'EFF' },
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
        // @ts-ignore - web-specific attribute
        data-hide-on-print="true"
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" numberOfLines={1}>
            {team?.name || 'Team'} Stats
          </ThemedText>
        </View>
        {isWeb && <PrintButton title="Print" />}
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
              <ThemedText variant="h3">Season Record</ThemedText>
              <View style={styles.record}>
                <ThemedText variant="h1" color="success">
                  {seasonStats.wins}
                </ThemedText>
                <ThemedText variant="h2" color="textTertiary"> - </ThemedText>
                <ThemedText variant="h1" color="error">
                  {seasonStats.losses}
                </ThemedText>
              </View>
            </View>
            <ThemedText variant="caption" color="textSecondary" style={styles.gamesPlayed}>
              {seasonStats.gamesPlayed} games played
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
            <ThemedText variant="h3" style={styles.sectionTitle}>
              Shooting Percentages
            </ThemedText>
            <View style={styles.shootingRow}>
              <View style={styles.shootingItem}>
                <ThemedText variant="h2">
                  {seasonStats.fieldGoalPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">FG%</ThemedText>
              </View>
              <View style={styles.shootingItem}>
                <ThemedText variant="h2">
                  {seasonStats.threePointPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">3P%</ThemedText>
              </View>
              <View style={styles.shootingItem}>
                <ThemedText variant="h2">
                  {seasonStats.freeThrowPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">FT%</ThemedText>
              </View>
            </View>
          </Card>
        )}

        {/* Recent Games */}
        {seasonStats && seasonStats.recentGames.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" style={styles.sectionTitle}>
              Recent Games
            </ThemedText>
            <Card variant="default">
              {seasonStats.recentGames.slice(0, 5).map((game) => (
                <ListItem
                  key={game.id}
                  title={game.opponent}
                  subtitle={new Date(game.date).toLocaleDateString()}
                  onPress={() => router.push(`/games/${game.id}/stats`)}
                  rightElement={
                    <View style={styles.gameResult}>
                      <ThemedText
                        variant="bodyBold"
                        style={{
                          color: game.result === 'W' ? colors.success : colors.error,
                        }}
                      >
                        {game.result}
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
              <ThemedText variant="h3">Roster Stats</ThemedText>
              <View style={styles.sortOptions}>
                {sortOptions.map((option) => (
                  <TouchableOpacity
                    key={option.key}
                    onPress={() => setSortBy(option.key)}
                    style={[
                      styles.sortButton,
                      {
                        backgroundColor:
                          sortBy === option.key
                            ? colors.primary + '20'
                            : 'transparent',
                        borderColor:
                          sortBy === option.key
                            ? colors.primary
                            : colors.border,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Sort by ${option.label}`}
                    accessibilityState={{ selected: sortBy === option.key }}
                  >
                    <ThemedText
                      variant="caption"
                      color={sortBy === option.key ? 'primary' : 'textSecondary'}
                    >
                      {option.label}
                    </ThemedText>
                  </TouchableOpacity>
                ))}
              </View>
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
              No games played yet. Statistics will appear here once games are completed.
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
    padding: spacing.sm,
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
    flexDirection: 'row',
    alignItems: 'center',
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
  sortOptions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  sortButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 36,
    justifyContent: 'center',
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
