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
  ListItem,
  EmptyState,
  LoadingSpinner,
} from '../../components';
import { SeasonAverages } from '../../components/stats';
import { useTeams } from '../../hooks/useTeams';
import { useTeamSeasonStats, useTeamRosterStats } from '../../hooks/useStats';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

export default function Stats() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: teams, isLoading: teamsLoading } = useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  // Auto-select first team if none selected
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

  // Top performers
  const topScorer = rosterStats?.[0];
  const sortedByRebounds = rosterStats ? [...rosterStats].sort((a, b) => b.reboundsPerGame - a.reboundsPerGame) : [];
  const topRebounder = sortedByRebounds[0];
  const sortedByAssists = rosterStats ? [...rosterStats].sort((a, b) => b.assistsPerGame - a.assistsPerGame) : [];
  const topAssister = sortedByAssists[0];

  if (teamsLoading) {
    return <LoadingSpinner message="Loading..." fullScreen />;
  }

  if (!teams || teams.length === 0) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={[styles.header, { paddingHorizontal: padding }]}>
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

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          {
            paddingHorizontal: padding,
            paddingTop: insets.top + spacing.md,
          },
        ]}
      >
        <ThemedText variant="h1">Statistics</ThemedText>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Team Selector */}
        {teams.length > 1 && (
          <View style={styles.teamSelector}>
            <ThemedText variant="caption" color="textSecondary" style={styles.selectorLabel}>
              Select Team
            </ThemedText>
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
                      color: selectedTeamId === team.id ? '#FFFFFF' : colors.text,
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
            {/* Season Record */}
            {seasonStats && seasonStats.gamesPlayed > 0 && (
              <Card
                variant="elevated"
                style={styles.recordCard}
                onPress={() => router.push(`/teams/${selectedTeamId}/stats`)}
              >
                <View style={styles.recordContent}>
                  <View>
                    <ThemedText variant="caption" color="textSecondary">
                      {selectedTeam?.name}
                    </ThemedText>
                    <View style={styles.record}>
                      <ThemedText variant="h1" color="success">
                        {seasonStats.wins}
                      </ThemedText>
                      <ThemedText variant="h2" color="textTertiary"> - </ThemedText>
                      <ThemedText variant="h1" color="error">
                        {seasonStats.losses}
                      </ThemedText>
                    </View>
                    <ThemedText variant="caption" color="textSecondary">
                      {seasonStats.gamesPlayed} games
                    </ThemedText>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={24}
                    color={colors.textTertiary}
                  />
                </View>
              </Card>
            )}

            {/* Season Averages */}
            {seasonStats && seasonStats.gamesPlayed > 0 && (
              <SeasonAverages stats={seasonStats} />
            )}

            {/* Team Leaders */}
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

                {topScorer && topScorer.gamesPlayed > 0 && (
                  <Card
                    variant="default"
                    style={styles.leaderCard}
                    onPress={() => router.push(`/players/${topScorer.playerId}/stats`)}
                  >
                    <View style={styles.leaderContent}>
                      <View style={styles.leaderInfo}>
                        <View
                          style={[
                            styles.leaderBadge,
                            { backgroundColor: colors.warning + '20' },
                          ]}
                        >
                          <Ionicons name="flame" size={16} color={colors.warning} />
                        </View>
                        <View>
                          <ThemedText variant="caption" color="textSecondary">
                            Points Leader
                          </ThemedText>
                          <ThemedText variant="bodyBold">
                            {topScorer.playerName}
                          </ThemedText>
                        </View>
                      </View>
                      <View style={styles.leaderStat}>
                        <ThemedText variant="h2">
                          {topScorer.pointsPerGame.toFixed(1)}
                        </ThemedText>
                        <ThemedText variant="caption" color="textSecondary">
                          PPG
                        </ThemedText>
                      </View>
                    </View>
                  </Card>
                )}

                {topRebounder && topRebounder.gamesPlayed > 0 && topRebounder.playerId !== topScorer?.playerId && (
                  <Card
                    variant="default"
                    style={styles.leaderCard}
                    onPress={() => router.push(`/players/${topRebounder.playerId}/stats`)}
                  >
                    <View style={styles.leaderContent}>
                      <View style={styles.leaderInfo}>
                        <View
                          style={[
                            styles.leaderBadge,
                            { backgroundColor: colors.info + '20' },
                          ]}
                        >
                          <Ionicons name="basketball" size={16} color={colors.info} />
                        </View>
                        <View>
                          <ThemedText variant="caption" color="textSecondary">
                            Rebounds Leader
                          </ThemedText>
                          <ThemedText variant="bodyBold">
                            {topRebounder.playerName}
                          </ThemedText>
                        </View>
                      </View>
                      <View style={styles.leaderStat}>
                        <ThemedText variant="h2">
                          {topRebounder.reboundsPerGame.toFixed(1)}
                        </ThemedText>
                        <ThemedText variant="caption" color="textSecondary">
                          RPG
                        </ThemedText>
                      </View>
                    </View>
                  </Card>
                )}

                {topAssister && topAssister.gamesPlayed > 0 &&
                 topAssister.playerId !== topScorer?.playerId &&
                 topAssister.playerId !== topRebounder?.playerId && (
                  <Card
                    variant="default"
                    style={styles.leaderCard}
                    onPress={() => router.push(`/players/${topAssister.playerId}/stats`)}
                  >
                    <View style={styles.leaderContent}>
                      <View style={styles.leaderInfo}>
                        <View
                          style={[
                            styles.leaderBadge,
                            { backgroundColor: colors.success + '20' },
                          ]}
                        >
                          <Ionicons name="swap-horizontal" size={16} color={colors.success} />
                        </View>
                        <View>
                          <ThemedText variant="caption" color="textSecondary">
                            Assists Leader
                          </ThemedText>
                          <ThemedText variant="bodyBold">
                            {topAssister.playerName}
                          </ThemedText>
                        </View>
                      </View>
                      <View style={styles.leaderStat}>
                        <ThemedText variant="h2">
                          {topAssister.assistsPerGame.toFixed(1)}
                        </ThemedText>
                        <ThemedText variant="caption" color="textSecondary">
                          APG
                        </ThemedText>
                      </View>
                    </View>
                  </Card>
                )}
              </View>
            )}

            {/* Recent Games Quick View */}
            {seasonStats && seasonStats.recentGames.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <ThemedText variant="h3">Recent Games</ThemedText>
                </View>
                <Card variant="default">
                  {seasonStats.recentGames.slice(0, 3).map((game) => (
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
  container: {
    flex: 1,
  },
  header: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  scrollContent: {
    paddingTop: spacing.sm,
  },
  teamSelector: {
    marginBottom: spacing.lg,
  },
  selectorLabel: {
    marginBottom: spacing.sm,
  },
  teamChips: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  teamChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
  },
  recordCard: {
    marginBottom: spacing.md,
  },
  recordContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  record: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.xs,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  leaderCard: {
    marginBottom: spacing.sm,
  },
  leaderContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  leaderInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  leaderBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaderStat: {
    alignItems: 'flex-end',
  },
  gameResult: {
    alignItems: 'flex-end',
  },
});
