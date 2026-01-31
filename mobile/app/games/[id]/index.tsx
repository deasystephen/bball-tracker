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
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  Button,
  LoadingSpinner,
  ErrorState,
} from '../../../components';
import { useGame, useUpdateGame, useDeleteGame } from '../../../hooks/useGames';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
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
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: game, isLoading, error, refetch } = useGame(id);
  const updateGame = useUpdateGame();
  const deleteGame = useDeleteGame();

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
      {/* Header with back button */}
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
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" numberOfLines={1}>
            Game Details
          </ThemedText>
        </View>
        {isScheduled && (
          <TouchableOpacity onPress={handleDelete} style={styles.iconButton}>
            <Ionicons name="trash-outline" size={24} color={colors.error} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Status Badge */}
        <View style={styles.statusContainer}>
          <View
            style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}
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

        {/* Score Card */}
        <Card variant="elevated" style={styles.scoreCard}>
          <View style={styles.scoreContainer}>
            <View style={styles.teamScore}>
              <ThemedText variant="caption" color="textSecondary">
                {game.team?.name || 'Your Team'}
              </ThemedText>
              <ThemedText variant="h1" style={styles.score}>
                {game.homeScore}
              </ThemedText>
            </View>
            <View style={styles.scoreDivider}>
              <ThemedText variant="h3" color="textTertiary">
                -
              </ThemedText>
            </View>
            <View style={[styles.teamScore, styles.awayTeamScore]}>
              <ThemedText variant="caption" color="textSecondary">
                {game.opponent}
              </ThemedText>
              <ThemedText variant="h1" style={styles.score}>
                {game.awayScore}
              </ThemedText>
            </View>
          </View>
        </Card>

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
  iconButton: {
    padding: spacing.xs,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  statusContainer: {
    alignItems: 'center',
    marginBottom: spacing.lg,
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
  scoreCard: {
    marginBottom: spacing.lg,
  },
  scoreContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  teamScore: {
    flex: 1,
    alignItems: 'center',
  },
  awayTeamScore: {
    alignItems: 'center',
  },
  score: {
    fontSize: 56,
    fontWeight: '700',
    lineHeight: 64,
    marginTop: spacing.xs,
  },
  scoreDivider: {
    paddingHorizontal: spacing.xl,
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
});
