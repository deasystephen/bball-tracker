/**
 * Game detail screen - view game, start/end tracking
 */

import React, { useMemo, useState } from 'react';
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
import { useGame, useUpdateGame, useDeleteGame, useGameRsvps, useSubmitRsvp } from '../../../hooks/useGames';
import { useBoxScore } from '../../../hooks/useStats';
import { useTheme } from '../../../hooks/useTheme';
import { useAuthStore } from '../../../store/auth-store';
import { guardianChildrenOnTeam, isRosteredOn } from '../../../utils/guardian';
import { childDisplayName } from '../../../utils/display-name';
import { spacing, typography } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { formatClockTime, formatLongDate } from '../../../utils/format-date';
import { getGamePermissions } from '../../../utils/game-permissions';
import type { GameStatus, RsvpStatus } from '../../../types/game';
import { useGoBack } from '../../../hooks/useGoBack';
import { HEADER_ICON_HIT_SLOP, MIN_TOUCH_TARGET } from '../../../utils/touch-target';
import { BackButton } from '../../../components/BackButton';
import { i18n, useTranslation } from '../../../i18n';

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
      return i18n.t('games.scheduled');
    case 'IN_PROGRESS':
      return i18n.t('games.inProgress');
    case 'FINISHED':
      return i18n.t('games.finished');
    case 'CANCELLED':
      return i18n.t('games.cancelled');
    default:
      return status;
  }
};

export default function GameDetailScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/games');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, colorScheme } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { user } = useAuthStore();
  const { data: game, isLoading, error, refetch } = useGame(id);
  const updateGame = useUpdateGame();
  const deleteGame = useDeleteGame();
  const { data: rsvpData } = useGameRsvps(id);
  const submitRsvp = useSubmitRsvp();

  // Fetch box score for finished games
  const isFinishedGame = game?.status === 'FINISHED';
  const { data: boxScore, isLoading: boxScoreLoading } = useBoxScore(
    isFinishedGame ? id : ''
  );

  const gradientColors = colorScheme === 'dark'
    ? ['#0D1117', '#161B22'] as const
    : ['#1A3A5C', '#0F2540'] as const;

  // Mirrors the backend: manage → create/edit/delete; manage|track → start/end;
  // track → the tracker. Players and non-staff only get Watch Live / RSVP /
  // box score (role matrix M12–M18).
  const permissions = getGamePermissions(game?.team, user);

  // RSVP on behalf of a child (PARENT role): a guardian of at least one
  // member of this team picks who they are responding for. `null` = self.
  const childrenOnTeam = useMemo(
    () => guardianChildrenOnTeam(user, game?.team),
    [user, game?.team]
  );
  const selfRostered = isRosteredOn(user, game?.team);
  const respondents = useMemo(() => {
    const list: { id: string | null; name: string }[] = [];
    if (selfRostered || childrenOnTeam.length === 0) list.push({ id: null, name: t('games.rsvp.me') });
    for (const child of childrenOnTeam) list.push({ id: child.childId, name: childDisplayName(child) });
    return list;
  }, [selfRostered, childrenOnTeam, t]);
  // `undefined` = nothing picked yet → derive the default (self, or the first
  // child when the guardian is not rostered themself). Derived rather than
  // synced in an effect so a roster change can't leave a stale pick.
  const [picked, setRespondingFor] = useState<string | null | undefined>(undefined);
  const respondingFor: string | null =
    picked !== undefined && respondents.some((r) => r.id === picked)
      ? picked
      : (respondents[0]?.id ?? null);
  const rsvpUserId = respondingFor ?? user?.id;

  const handleStartGame = async () => {
    try {
      await updateGame.mutateAsync({
        gameId: id,
        data: { status: 'IN_PROGRESS' },
      });
      if (permissions.canTrack) {
        router.push(`/games/${id}/track`);
      }
    } catch (err) {
      Alert.alert(
        t('common.error'),
        err instanceof Error ? err.message : t('games.startFailed')
      );
    }
  };

  const handleContinueTracking = () => {
    router.push(`/games/${id}/track`);
  };

  const handleEndGame = async () => {
    Alert.alert(t('games.endGame'), t('games.endGameConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('games.endGame'),
        style: 'destructive',
        onPress: async () => {
          try {
            await updateGame.mutateAsync({
              gameId: id,
              data: { status: 'FINISHED' },
            });
          } catch (err) {
            Alert.alert(
              t('common.error'),
              err instanceof Error ? err.message : t('games.endFailed')
            );
          }
        },
      },
    ]);
  };

  const handleDelete = () => {
    Alert.alert(
      t('games.deleteTitle'),
      game?.status === 'FINISHED' ? t('games.deleteFinishedConfirm') : t('games.deleteConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteGame.mutateAsync(id);
              router.replace('/(tabs)/games');
            } catch (err) {
              Alert.alert(
                t('common.error'),
                err instanceof Error ? err.message : t('games.deleteFailed')
              );
            }
          },
        },
      ]
    );
  };

  if (isLoading) {
    return <LoadingSpinner message={t('games.loadingGame')} fullScreen />;
  }

  if (error || !game) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('games.notFound')}
        onRetry={refetch}
        onBack={goBack}
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
          <BackButton onPress={goBack} style={styles.backButton} color="#FFFFFF" />
          <View style={styles.headerSpacer} />
          {/* Scheduled or finished only — deleting mid-tracking is more likely a
              mis-tap than intent (end the game first). Finished-game deletion
              cascades events + stats server-side; season totals recompute. */}
          {(isScheduled || isFinished) && permissions.canManage && (
            <TouchableOpacity
              onPress={handleDelete}
              style={styles.iconButton}
              hitSlop={HEADER_ICON_HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel={t('games.deleteA11y')}
            >
              <Ionicons name="trash-outline" size={24} color="#FFFFFF80" />
            </TouchableOpacity>
          )}
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
              {game.team?.name || t('games.yourTeam')}
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
                {t('games.date')}
              </ThemedText>
              <ThemedText variant="body">{formatLongDate(game.date)}</ThemedText>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.infoRow}>
            <Ionicons name="time-outline" size={20} color={colors.primary} />
            <View style={styles.infoContent}>
              <ThemedText variant="caption" color="textSecondary">
                {t('games.time')}
              </ThemedText>
              <ThemedText variant="body">{formatClockTime(game.date)}</ThemedText>
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
                    {t('teams.roster')}
                  </ThemedText>
                  <ThemedText variant="body">
                    {t('teams.playerCount', { count: game.team.members.length })}
                  </ThemedText>
                </View>
              </View>
            </>
          )}
        </Card>

        {/* RSVP Section - only for scheduled/upcoming games */}
        {(isScheduled || isInProgress) && (
          <Card variant="default" style={styles.rsvpCard}>
            <ThemedText variant="h3" heading style={styles.rsvpTitle}>{t('games.rsvp.title')}</ThemedText>

            {/* Responding for: self + each child on this team (guardians) */}
            {childrenOnTeam.length > 0 && (
              <View style={styles.respondingFor} testID="rsvp-responding-for">
                <ThemedText variant="caption" color="textSecondary" style={styles.respondingForLabel}>
                  {t('games.rsvp.respondingFor')}
                </ThemedText>
                <View style={styles.respondingForChips}>
                  {respondents.map((respondent) => {
                    const selected = respondent.id === respondingFor;
                    return (
                      <TouchableOpacity
                        key={respondent.id ?? 'self'}
                        onPress={() => setRespondingFor(respondent.id)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={t('games.rsvp.respondForA11y', { name: respondent.name })}
                        style={[
                          styles.respondingForChip,
                          { borderColor: colors.border },
                          selected && { backgroundColor: colors.primary, borderColor: colors.primary },
                        ]}
                      >
                        <ThemedText
                          variant="captionBold"
                          style={selected ? { color: '#FFFFFF' } : undefined}
                        >
                          {respondent.name}
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* RSVP Buttons */}
            <View style={styles.rsvpButtons}>
              {(['YES', 'NO', 'MAYBE'] as RsvpStatus[]).map((status) => {
                const myRsvp = rsvpData?.rsvps?.find(r => r.userId === rsvpUserId);
                const isSelected = myRsvp?.status === status;
                const label =
                  status === 'YES'
                    ? t('games.rsvp.going')
                    : status === 'NO'
                      ? t('games.rsvp.notGoing')
                      : t('games.rsvp.maybe');
                return (
                  <TouchableOpacity
                    key={status}
                    style={[
                      styles.rsvpButton,
                      { borderColor: colors.border },
                      isSelected && { backgroundColor: colors.primary, borderColor: colors.primary },
                    ]}
                    onPress={() =>
                      submitRsvp.mutate({ gameId: id, status, playerId: respondingFor ?? undefined })
                    }
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <ThemedText
                      variant="captionBold"
                      style={isSelected ? { color: '#FFFFFF' } : undefined}
                    >
                      {label}
                    </ThemedText>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* RSVP Summary */}
            {rsvpData?.summary && (
              <View style={styles.rsvpSummary}>
                <ThemedText variant="caption" color="textSecondary">
                  {[
                    t('games.rsvp.goingCount', { count: rsvpData.summary.yes }),
                    ...(rsvpData.summary.maybe > 0
                      ? [t('games.rsvp.maybeCount', { count: rsvpData.summary.maybe })]
                      : []),
                    ...(rsvpData.summary.no > 0
                      ? [t('games.rsvp.notGoingCount', { count: rsvpData.summary.no })]
                      : []),
                  ].join(' \u00B7 ')}
                </ThemedText>
              </View>
            )}
          </Card>
        )}

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          {isScheduled && permissions.canChangeStatus && (
            <Button
              title={t('games.start')}
              onPress={handleStartGame}
              loading={updateGame.isPending}
              fullWidth
              size="large"
            />
          )}

          {isInProgress && (
            <>
              <Button
                title={t('games.watchLive')}
                variant="secondary"
                onPress={() => router.push(`/games/${id}/live`)}
                fullWidth
                size="large"
              />
              {permissions.canTrack && (
                <Button
                  title={t('games.continueTracking')}
                  onPress={handleContinueTracking}
                  fullWidth
                  size="large"
                  style={styles.endButton}
                />
              )}
              {permissions.canChangeStatus && (
                <Button
                  title={t('games.endGame')}
                  variant="danger"
                  onPress={handleEndGame}
                  loading={updateGame.isPending}
                  fullWidth
                  style={styles.endButton}
                />
              )}
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
                  {t('games.completed')}
                </ThemedText>
              </Card>

              {/* Box Score Section */}
              <View style={styles.boxScoreSection}>
                <View style={styles.sectionHeader}>
                  <ThemedText variant="h3" heading>{t('games.boxScore')}</ThemedText>
                  <TouchableOpacity
                    onPress={() => router.push(`/games/${id}/stats`)}
                    style={styles.viewAllButton}
                    accessibilityRole="button"
                  >
                    <ThemedText variant="caption" color="primary">
                      {t('games.viewFullStats')}
                    </ThemedText>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color={colors.primary}
                    />
                  </TouchableOpacity>
                </View>

                {boxScoreLoading ? (
                  <LoadingSpinner message={t('games.loadingStats')} />
                ) : boxScore ? (
                  <BoxScoreTable
                    players={boxScore.team.players}
                    teamStats={boxScore.team.stats}
                    showExtendedStats={false}
                  />
                ) : (
                  <Card variant="default">
                    <ThemedText variant="body" color="textSecondary">
                      {t('games.noStats')}
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
    marginLeft: -spacing.xs,
  },
  headerSpacer: {
    flex: 1,
  },
  // Drawn like BackButton (24pt icon, spacing.sm padding = 40pt) so both
  // header icons share one size; HEADER_ICON_HIT_SLOP makes it a 44pt target.
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
  rsvpCard: {
    marginBottom: spacing.lg,
  },
  rsvpTitle: {
    marginBottom: spacing.md,
  },
  respondingFor: {
    marginBottom: spacing.md,
  },
  respondingForLabel: {
    marginBottom: spacing.xs,
  },
  respondingForChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  respondingForChip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  rsvpButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  rsvpButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  rsvpSummary: {
    marginTop: spacing.md,
    alignItems: 'center',
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
