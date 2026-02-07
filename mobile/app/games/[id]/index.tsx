/**
 * Game detail screen - view game, start/end tracking
 */

import React from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  Button,
  LoadingSpinner,
  ErrorState,
} from '../../../components';
import { BoxScoreTable } from '../../../components/stats';
import { useGame, useUpdateGame, useDeleteGame } from '../../../hooks/useGames';
import { useBoxScore } from '../../../hooks/useStats';
import { useTheme } from '../../../hooks/useTheme';
import { spacing, typography } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import type { GameStatus } from '../../../types/game';

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
      return 'In Progress';
    case 'FINISHED':
      return 'Finished';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status;
  }
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
};

const formatTime = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
};

export default function GameDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, colorScheme } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: game, isLoading, error, refetch } = useGame(id);
  const updateGame = useUpdateGame();
  const deleteGame = useDeleteGame();

  // Fetch box score for finished games
  const isFinishedGame = game?.status === 'FINISHED';
  const { data: boxScore, isLoading: boxScoreLoading } = useBoxScore(
    isFinishedGame ? id : ''
  );

  const gradientColors = colorScheme === 'dark'
    ? ['#0D1117', '#161B22'] as const
    : ['#1A3A5C', '#0F2540'] as const;

  const handleStartGame = async () => {
    try {
      await updateGame.mutateAsync({
        gameId: id,
        data: { status: 'IN_PROGRESS' },
      });
      router.push(`/games/${id}/track`);
    } catch (err) {
      Alert.alert(
        'Error',
        err instanceof Error ? err.message : 'Failed to start game'
      );
    }
  };

  const handleContinueTracking = () => {
    router.push(`/games/${id}/track`);
  };

  const handleEndGame = async () => {
    Alert.alert('End Game', 'Are you sure you want to end this game?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Game',
        style: 'destructive',
        onPress: async () => {
          try {
            await updateGame.mutateAsync({
              gameId: id,
              data: { status: 'FINISHED' },
            });
          } catch (err) {
            Alert.alert(
              'Error',
              err instanceof Error ? err.message : 'Failed to end game'
            );
          }
        },
      },
    ]);
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Game',
      'Are you sure you want to delete this game? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteGame.mutateAsync(id);
              router.replace('/(tabs)/games');
            } catch (err) {
              Alert.alert(
                'Error',
                err instanceof Error ? err.message : 'Failed to delete game'
              );
            }
          },
        },
      ]
    );
  };

  if (isLoading) {
    return <LoadingSpinner message="Loading game..." fullScreen />;
  }

  if (error || !game) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Game not found'}
        onRetry={refetch}
      />
    );
  }

  const statusColor = getStatusColor(game.status, colors);
  const isScheduled = game.status === 'SCHEDULED';
  const isInProgress = game.status === 'IN_PROGRESS';
  const isFinished = game.status === 'FINISHED';

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Immersive dark scoreboard header */}
      <LinearGradient
        colors={gradientColors}
        style={[
          styles.immersiveHeader,
          { paddingTop: insets.top + spacing.sm },
        ]}
      >
        <View style={[styles.headerActions, { paddingHorizontal: padding }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
          </TouchableOpacity>
          <View style={styles.headerSpacer} />
          {isScheduled && (
            <TouchableOpacity
              onPress={handleDelete}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Delete game"
            >
              <Ionicons name="trash-outline" size={24} color="#FFFFFF80" />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Share game"
          >
            <Ionicons name="share-outline" size={24} color="#FFFFFF80" />
          </TouchableOpacity>
        </View>

        {/* Status */}
        <View style={styles.statusContainer}>
          <View
            style={[styles.statusBadge, { backgroundColor: statusColor + '30' }]}
          >
            {isInProgress && (
              <View style={[styles.liveDot, { backgroundColor: statusColor }]} />
            )}
            <ThemedText
              variant="captionBold"
              style={{ color: statusColor }}
            >
              {getStatusLabel(game.status)}
            </ThemedText>
          </View>
        </View>

        {/* Score in header */}
        <View style={styles.scoreContainer}>
          <View style={styles.teamScore}>
            <ThemedText variant="caption" style={styles.headerTeamName}>
              {game.team?.name || 'Your Team'}
            </ThemedText>
            <ThemedText variant="body" style={styles.headerScore}>
              {game.homeScore}
            </ThemedText>
          </View>
          <View style={styles.scoreDivider}>
            <View style={styles.verticalLine} />
          </View>
          <View style={[styles.teamScore, styles.awayTeamScore]}>
            <ThemedText variant="caption" style={styles.headerTeamName}>
              {game.opponent}
            </ThemedText>
            <ThemedText variant="body" style={styles.headerScore}>
              {game.awayScore}
            </ThemedText>
          </View>
        </View>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Game Info */}
        <Card variant="default" style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons
              name="calendar-outline"
              size={20}
              color={colors.primary}
            />
            <View style={styles.infoContent}>
              <ThemedText variant="caption" color="textSecondary">
                Date
              </ThemedText>
              <ThemedText variant="body">{formatDate(game.date)}</ThemedText>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.infoRow}>
            <Ionicons name="time-outline" size={20} color={colors.primary} />
            <View style={styles.infoContent}>
              <ThemedText variant="caption" color="textSecondary">
                Time
              </ThemedText>
              <ThemedText variant="body">{formatTime(game.date)}</ThemedText>
            </View>
          </View>

          {game.team?.members && (
            <>
              <View
                style={[styles.divider, { backgroundColor: colors.border }]}
              />
              <View style={styles.infoRow}>
                <Ionicons
                  name="people-outline"
                  size={20}
                  color={colors.primary}
                />
                <View style={styles.infoContent}>
                  <ThemedText variant="caption" color="textSecondary">
                    Roster
                  </ThemedText>
                  <ThemedText variant="body">
                    {game.team.members.length} players
                  </ThemedText>
                </View>
              </View>
            </>
          )}
        </Card>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          {isScheduled && (
            <Button
              title="Start Game"
              onPress={handleStartGame}
              loading={updateGame.isPending}
              fullWidth
              size="large"
            />
          )}

          {isInProgress && (
            <>
              <Button
                title="Continue Tracking"
                onPress={handleContinueTracking}
                fullWidth
                size="large"
              />
              <Button
                title="End Game"
                variant="danger"
                onPress={handleEndGame}
                loading={updateGame.isPending}
                fullWidth
                style={styles.endButton}
              />
            </>
          )}

          {isFinished && (
            <>
              <Card
                variant="default"
                style={[
                  styles.finishedCard,
                  { backgroundColor: colors.backgroundSecondary },
                ]}
              >
                <Ionicons
                  name="checkmark-circle"
                  size={32}
                  color={colors.success}
                />
                <ThemedText variant="body" style={styles.finishedText}>
                  Game completed
                </ThemedText>
              </Card>

              {/* Box Score Section */}
              <View style={styles.boxScoreSection}>
                <View style={styles.sectionHeader}>
                  <ThemedText variant="h3">Box Score</ThemedText>
                  <TouchableOpacity
                    onPress={() => router.push(`/games/${id}/stats`)}
                    style={styles.viewAllButton}
                  >
                    <ThemedText variant="caption" color="primary">
                      View Full Stats
                    </ThemedText>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color={colors.primary}
                    />
                  </TouchableOpacity>
                </View>

                {boxScoreLoading ? (
                  <LoadingSpinner message="Loading stats..." />
                ) : boxScore ? (
                  <BoxScoreTable
                    players={boxScore.team.players}
                    teamStats={boxScore.team.stats}
                    showExtendedStats={false}
                  />
                ) : (
                  <Card variant="default">
                    <ThemedText variant="body" color="textSecondary">
                      No statistics recorded for this game.
                    </ThemedText>
                  </Card>
                )}
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  immersiveHeader: {
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  backButton: {
    padding: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerSpacer: {
    flex: 1,
  },
  iconButton: {
    padding: spacing.sm,
  },
  statusContainer: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
    gap: spacing.xs,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  scoreContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  teamScore: {
    flex: 1,
    alignItems: 'center',
  },
  awayTeamScore: {
    alignItems: 'center',
  },
  headerTeamName: {
    color: '#FFFFFF',
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: spacing.xs,
  },
  headerScore: {
    ...typography.displaySmall,
    color: '#FFFFFF',
    lineHeight: 64,
  },
  scoreDivider: {
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verticalLine: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  infoCard: {
    marginBottom: spacing.lg,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  infoContent: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.xs,
  },
  actionButtons: {
    marginTop: spacing.lg,
  },
  endButton: {
    marginTop: spacing.md,
  },
  finishedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  finishedText: {
    fontWeight: '600',
  },
  boxScoreSection: {
    marginTop: spacing.xl,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
