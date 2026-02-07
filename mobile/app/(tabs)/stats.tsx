/**
 * Stats hub screen - view team and player statistics
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  EmptyState,
  LoadingSpinner,
} from '../../components';
import { SeasonAverages } from '../../components/stats';
import { useTeams } from '../../hooks/useTeams';
import { useTeamSeasonStats, useTeamRosterStats } from '../../hooks/useStats';
import { useTheme } from '../../hooks/useTheme';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

export default function Stats() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: teams, isLoading: teamsLoading } = useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  React.useEffect(() => {
    if (teams && teams.length > 0 && !selectedTeamId) {
      setSelectedTeamId(teams[0].id);
    }
  }, [teams, selectedTeamId]);

  const { data: seasonStats, isLoading: statsLoading } = useTeamSeasonStats(
    selectedTeamId || ''
  );
  const { data: rosterStats, isLoading: rosterLoading } = useTeamRosterStats(
    selectedTeamId || ''
  );

  const selectedTeam = teams?.find((t) => t.id === selectedTeamId);
  const isLoading = teamsLoading || statsLoading || rosterLoading;

  const topScorer = rosterStats?.[0];
  const sortedByRebounds = rosterStats
    ? [...rosterStats].sort((a, b) => b.reboundsPerGame - a.reboundsPerGame)
    : [];
  const topRebounder = sortedByRebounds[0];
  const sortedByAssists = rosterStats
    ? [...rosterStats].sort((a, b) => b.assistsPerGame - a.assistsPerGame)
    : [];
  const topAssister = sortedByAssists[0];

  if (teamsLoading) {
    return <LoadingSpinner message="Loading..." fullScreen />;
  }

  if (!teams || teams.length === 0) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View
          style={[
            styles.header,
            { paddingHorizontal: padding, paddingTop: insets.top + spacing.md },
          ]}
        >
          <ThemedText variant="h1">Statistics</ThemedText>
        </View>
        <EmptyState
          icon="stats-chart-outline"
          title="No Teams Yet"
          message="Join or create a team to start tracking statistics."
        />
      </ThemedView>
    );
  }

  // Win/loss streak from recent games
  const recentResults =
    seasonStats?.recentGames?.slice(0, 10).map((g) => g.result) || [];

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingHorizontal: padding, paddingTop: insets.top + spacing.md },
        ]}
      >
        <ThemedText variant="h1">Statistics</ThemedText>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Team Selector */}
        {teams.length > 1 && (
          <View style={styles.teamSelector}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.teamChips}
            >
              {teams.map((team) => (
                <TouchableOpacity
                  key={team.id}
                  onPress={() => setSelectedTeamId(team.id)}
                  style={[
                    styles.teamChip,
                    {
                      backgroundColor:
                        selectedTeamId === team.id
                          ? colors.primary
                          : colors.backgroundSecondary,
                      borderColor:
                        selectedTeamId === team.id
                          ? colors.primary
                          : colors.border,
                    },
                  ]}
                >
                  <ThemedText
                    variant="caption"
                    style={{
                      color:
                        selectedTeamId === team.id ? '#FFFFFF' : colors.text,
                    }}
                  >
                    {team.name}
                  </ThemedText>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {isLoading ? (
          <LoadingSpinner message="Loading stats..." />
        ) : (
          <>
            {/* Win/Loss Record with Streak */}
            {seasonStats && seasonStats.gamesPlayed > 0 && (
              <Card
                variant="elevated"
                style={styles.recordCard}
                onPress={() => router.push(`/teams/${selectedTeamId}/stats`)}
              >
                <ThemedText variant="caption" color="textSecondary">
                  {selectedTeam?.name}
                </ThemedText>
                <View style={styles.recordRow}>
                  <View style={styles.recordNum}>
                    <ThemedText
                      variant="h1"
                      style={{ color: colors.success, fontSize: 48, lineHeight: 54 }}
                    >
                      {seasonStats.wins}
                    </ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      W
                    </ThemedText>
                  </View>
                  <ThemedText variant="h2" color="textTertiary">
                    -
                  </ThemedText>
                  <View style={styles.recordNum}>
                    <ThemedText
                      variant="h1"
                      style={{ color: colors.error, fontSize: 48, lineHeight: 54 }}
                    >
                      {seasonStats.losses}
                    </ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      L
                    </ThemedText>
                  </View>
                </View>

                {/* Streak indicator dots */}
                {recentResults.length > 0 && (
                  <View style={styles.streakRow}>
                    {recentResults.slice(0, 8).map((result, idx) => (
                      <View
                        key={idx}
                        style={[
                          styles.streakDot,
                          {
                            backgroundColor:
                              result === 'W' ? colors.success : colors.error,
                          },
                        ]}
                      />
                    ))}
                  </View>
                )}
              </Card>
            )}

            {/* Season Averages */}
            {seasonStats && seasonStats.gamesPlayed > 0 && (
              <SeasonAverages stats={seasonStats} />
            )}

            {/* Team Leaders - Podium */}
            {rosterStats && rosterStats.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <ThemedText variant="h3">Team Leaders</ThemedText>
                  <TouchableOpacity
                    onPress={() => router.push(`/teams/${selectedTeamId}/stats`)}
                  >
                    <ThemedText variant="caption" color="primary">
                      View All
                    </ThemedText>
                  </TouchableOpacity>
                </View>

                <View style={styles.podiumRow}>
                  {/* Left - Rebounder */}
                  {topRebounder && topRebounder.gamesPlayed > 0 && (
                    <TouchableOpacity
                      style={[
                        styles.podiumCard,
                        styles.podiumSide,
                        { backgroundColor: colors.backgroundSecondary },
                      ]}
                      onPress={() =>
                        router.push(`/players/${topRebounder.playerId}/stats`)
                      }
                    >
                      <View
                        style={[
                          styles.podiumBadge,
                          { backgroundColor: colors.info + '20' },
                        ]}
                      >
                        <Ionicons
                          name="basketball"
                          size={16}
                          color={colors.info}
                        />
                      </View>
                      <ThemedText
                        variant="captionBold"
                        numberOfLines={1}
                        style={styles.podiumName}
                      >
                        {topRebounder.playerName.split(' ')[0]}
                      </ThemedText>
                      <ThemedText variant="h3">
                        {topRebounder.reboundsPerGame.toFixed(1)}
                      </ThemedText>
                      <ThemedText variant="footnote" color="textSecondary">
                        RPG
                      </ThemedText>
                    </TouchableOpacity>
                  )}

                  {/* Center - Top Scorer (larger) */}
                  {topScorer && topScorer.gamesPlayed > 0 && (
                    <TouchableOpacity
                      style={[
                        styles.podiumCard,
                        styles.podiumCenter,
                        { backgroundColor: colors.backgroundSecondary },
                      ]}
                      onPress={() =>
                        router.push(`/players/${topScorer.playerId}/stats`)
                      }
                    >
                      <View
                        style={[
                          styles.podiumBadge,
                          { backgroundColor: colors.warning + '20' },
                        ]}
                      >
                        <Ionicons
                          name="flame"
                          size={18}
                          color={colors.warning}
                        />
                      </View>
                      <ThemedText
                        variant="bodyBold"
                        numberOfLines={1}
                        style={styles.podiumName}
                      >
                        {topScorer.playerName.split(' ')[0]}
                      </ThemedText>
                      <ThemedText variant="h2">
                        {topScorer.pointsPerGame.toFixed(1)}
                      </ThemedText>
                      <ThemedText variant="footnote" color="textSecondary">
                        PPG
                      </ThemedText>
                    </TouchableOpacity>
                  )}

                  {/* Right - Assister */}
                  {topAssister && topAssister.gamesPlayed > 0 && (
                    <TouchableOpacity
                      style={[
                        styles.podiumCard,
                        styles.podiumSide,
                        { backgroundColor: colors.backgroundSecondary },
                      ]}
                      onPress={() =>
                        router.push(`/players/${topAssister.playerId}/stats`)
                      }
                    >
                      <View
                        style={[
                          styles.podiumBadge,
                          { backgroundColor: colors.success + '20' },
                        ]}
                      >
                        <Ionicons
                          name="swap-horizontal"
                          size={16}
                          color={colors.success}
                        />
                      </View>
                      <ThemedText
                        variant="captionBold"
                        numberOfLines={1}
                        style={styles.podiumName}
                      >
                        {topAssister.playerName.split(' ')[0]}
                      </ThemedText>
                      <ThemedText variant="h3">
                        {topAssister.assistsPerGame.toFixed(1)}
                      </ThemedText>
                      <ThemedText variant="footnote" color="textSecondary">
                        APG
                      </ThemedText>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            {/* No Stats Yet */}
            {(!seasonStats || seasonStats.gamesPlayed === 0) && (
              <EmptyState
                icon="stats-chart-outline"
                title="No Statistics Yet"
                message="Complete some games to see team and player statistics here."
              />
            )}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingBottom: spacing.sm },
  scrollContent: { paddingTop: spacing.sm },
  teamSelector: { marginBottom: spacing.lg },
  teamChips: { flexDirection: 'row', gap: spacing.sm },
  teamChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  recordCard: { marginBottom: spacing.md, alignItems: 'center' },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginVertical: spacing.sm,
  },
  recordNum: { alignItems: 'center' },
  streakRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  streakDot: { width: 8, height: 8, borderRadius: 4 },
  section: { marginTop: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  podiumRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  podiumCard: {
    alignItems: 'center',
    borderRadius: borderRadius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  podiumCenter: { flex: 1.3, paddingVertical: spacing.lg },
  podiumSide: { flex: 1 },
  podiumBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  podiumName: { textAlign: 'center' },
});
