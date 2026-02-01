/**
 * Player stats profile - individual player statistics across teams and seasons
 */

import React from 'react';
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
  LoadingSpinner,
  ErrorState,
} from '../../../components';
import { SeasonAverages, PlayerStatsCard } from '../../../components/stats';
import { PrintButton } from '../../../components/PrintButton';
import { usePlayerOverallStats } from '../../../hooks/useStats';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding, isWeb } from '../../../utils/responsive';

export default function PlayerStatsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data, isLoading, error, refetch } = usePlayerOverallStats(id);

  if (isLoading) {
    return <LoadingSpinner message="Loading player stats..." fullScreen />;
  }

  if (error || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load stats'}
        onRetry={refetch}
      />
    );
  }

  const { player, teams, careerTotals } = data;

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
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" numberOfLines={1}>
            Player Stats
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
        {/* Player Header */}
        <Card variant="elevated" style={styles.playerHeader}>
          <View style={styles.avatarContainer}>
            <View style={[styles.avatar, { backgroundColor: colors.primary + '20' }]}>
              <ThemedText variant="h1" color="primary">
                {player.name.charAt(0).toUpperCase()}
              </ThemedText>
            </View>
          </View>
          <ThemedText variant="h2" style={styles.playerName}>
            {player.name}
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {teams.length} team{teams.length !== 1 ? 's' : ''} | {careerTotals.gamesPlayed} games
          </ThemedText>
        </Card>

        {/* Career Totals */}
        {careerTotals.gamesPlayed > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" style={styles.sectionTitle}>
              Career Averages
            </ThemedText>
            <SeasonAverages stats={careerTotals} />

            {/* Career Totals Card */}
            <Card variant="default" style={styles.careerCard}>
              <ThemedText variant="bodyBold" style={styles.cardTitle}>
                Career Totals
              </ThemedText>
              <View style={styles.totalsRow}>
                <View style={styles.totalItem}>
                  <ThemedText variant="h3">{careerTotals.points}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">Points</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="h3">{careerTotals.rebounds}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">Rebounds</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="h3">{careerTotals.assists}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">Assists</ThemedText>
                </View>
              </View>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <View style={styles.totalsRow}>
                <View style={styles.totalItem}>
                  <ThemedText variant="body">{careerTotals.steals}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">Steals</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="body">{careerTotals.blocks}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">Blocks</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="body">{careerTotals.efficiency.toFixed(1)}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">Efficiency</ThemedText>
                </View>
              </View>
            </Card>

            {/* Shooting Stats */}
            <Card variant="default" style={styles.shootingCard}>
              <ThemedText variant="bodyBold" style={styles.cardTitle}>
                Shooting
              </ThemedText>
              <View style={styles.shootingRow}>
                <View style={styles.shootingItem}>
                  <ThemedText variant="h3">
                    {careerTotals.fieldGoalPercentage.toFixed(1)}%
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    FG ({careerTotals.fieldGoalsMade}/{careerTotals.fieldGoalsAttempted})
                  </ThemedText>
                </View>
                <View style={styles.shootingItem}>
                  <ThemedText variant="h3">
                    {careerTotals.threePointPercentage.toFixed(1)}%
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    3P ({careerTotals.threePointersMade}/{careerTotals.threePointersAttempted})
                  </ThemedText>
                </View>
                <View style={styles.shootingItem}>
                  <ThemedText variant="h3">
                    {careerTotals.freeThrowPercentage.toFixed(1)}%
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    FT ({careerTotals.freeThrowsMade}/{careerTotals.freeThrowsAttempted})
                  </ThemedText>
                </View>
              </View>
            </Card>
          </View>
        )}

        {/* Stats by Team */}
        {teams.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" style={styles.sectionTitle}>
              Stats by Team
            </ThemedText>
            {teams.map((teamData) => (
              <View key={teamData.teamId} style={styles.teamSection}>
                <TouchableOpacity
                  style={styles.teamHeader}
                  onPress={() => router.push(`/teams/${teamData.teamId}/stats`)}
                >
                  <View>
                    <ThemedText variant="bodyBold">{teamData.teamName}</ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      {teamData.seasonName}
                    </ThemedText>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color={colors.textTertiary}
                  />
                </TouchableOpacity>
                <PlayerStatsCard
                  stats={teamData.stats}
                  showAverages={true}
                  compact={false}
                />
              </View>
            ))}
          </View>
        )}

        {/* Empty State */}
        {careerTotals.gamesPlayed === 0 && (
          <Card variant="default" style={styles.emptyCard}>
            <Ionicons name="stats-chart-outline" size={48} color={colors.textTertiary} />
            <ThemedText variant="body" color="textSecondary" style={styles.emptyText}>
              No statistics available yet. Stats will appear here once games are played.
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
    padding: spacing.xs,
    marginRight: spacing.sm,
  },
  headerContent: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  playerHeader: {
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  avatarContainer: {
    marginBottom: spacing.md,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerName: {
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    marginBottom: spacing.md,
  },
  careerCard: {
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTitle: {
    marginBottom: spacing.md,
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  totalItem: {
    alignItems: 'center',
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.md,
  },
  shootingCard: {
    padding: spacing.lg,
  },
  shootingRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: spacing.sm,
  },
  shootingItem: {
    alignItems: 'center',
    flex: 1,
  },
  teamSection: {
    marginBottom: spacing.md,
  },
  teamHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    paddingVertical: spacing.xs,
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
