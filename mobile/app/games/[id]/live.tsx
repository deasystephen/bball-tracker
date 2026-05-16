/**
 * Spectator live-view screen. Read-only.
 *
 * Renders score + recent plays driven by Socket.io. The initial useGame() call
 * provides team name + a baseline render before the snapshot arrives so we
 * don't flash a 0–0 placeholder against an unknown opponent.
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
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  LoadingSpinner,
  ErrorState,
} from '../../../components';
import { EventTimeline } from '../../../components/game';
import { useGame } from '../../../hooks/useGames';
import { useLiveGame } from '../../../hooks/useLiveGame';
import { useTheme } from '../../../hooks/useTheme';
import { spacing, typography } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import type { GameStatus } from '../../../types/game';

export default function GameLiveScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, colorScheme } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: game, isLoading, error, refetch } = useGame(id);
  const live = useLiveGame(id);

  const gradientColors =
    colorScheme === 'dark'
      ? (['#0D1117', '#161B22'] as const)
      : (['#1A3A5C', '#0F2540'] as const);

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

  // Prefer live snapshot once available, fall back to REST game.
  const status: GameStatus = live.status ?? game.status;
  const homeScore =
    live.status !== null ? live.score.homeScore : game.homeScore;
  const awayScore =
    live.status !== null ? live.score.awayScore : game.awayScore;
  const isLive = status === 'IN_PROGRESS';
  const isFinished = status === 'FINISHED';
  const isScheduled = status === 'SCHEDULED';

  const showBanner =
    live.connectionState === 'connecting' ||
    live.connectionState === 'reconnecting' ||
    live.connectionState === 'error';
  const bannerText =
    live.connectionState === 'error'
      ? live.error ?? 'Connection error'
      : live.connectionState === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…';

  return (
    <ThemedView variant="background" style={styles.container}>
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
        </View>

        <View style={styles.statusContainer}>
          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor:
                  (isFinished ? colors.textTertiary : colors.error) + '30',
              },
            ]}
            accessibilityLabel={isFinished ? 'Final' : isLive ? 'Live' : 'Status'}
          >
            {isLive && (
              <View style={[styles.liveDot, { backgroundColor: colors.error }]} />
            )}
            <ThemedText
              variant="captionBold"
              style={{
                color: isFinished ? colors.textTertiary : colors.error,
              }}
            >
              {isFinished ? 'FINAL' : isLive ? 'LIVE' : 'Not Started'}
            </ThemedText>
          </View>
        </View>

        <View style={styles.scoreContainer}>
          <View style={styles.teamScore}>
            <ThemedText variant="caption" style={styles.headerTeamName}>
              {game.team?.name || 'Your Team'}
            </ThemedText>
            <ThemedText variant="body" style={styles.headerScore}>
              {homeScore}
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
              {awayScore}
            </ThemedText>
          </View>
        </View>
      </LinearGradient>

      {showBanner && (
        <View
          style={[styles.banner, { backgroundColor: colors.backgroundSecondary }]}
          accessibilityLabel="Connection status"
        >
          <Ionicons
            name="sync"
            size={14}
            color={colors.textSecondary}
          />
          <ThemedText variant="caption" color="textSecondary">
            {bannerText}
          </ThemedText>
        </View>
      )}

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {isScheduled ? (
          <Card variant="default" style={styles.emptyCard}>
            <Ionicons
              name="time-outline"
              size={32}
              color={colors.textTertiary}
            />
            <ThemedText variant="body" color="textSecondary" style={styles.emptyText}>
              Game hasn&apos;t started yet
            </ThemedText>
          </Card>
        ) : (
          <EventTimeline events={live.events} maxEvents={20} />
        )}
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
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  emptyCard: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  emptyText: {
    textAlign: 'center',
  },
});
