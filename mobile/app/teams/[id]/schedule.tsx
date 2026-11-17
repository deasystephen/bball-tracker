/**
 * Team schedule (#33): the team's games and practices from the start of
 * today through the next `SCHEDULE_WINDOW_DAYS` days, in one list by start
 * time. Reached from team detail ("Schedule").
 * Practices show a repeat icon when they belong to a series and a cancelled
 * state; a coach with `canManageTeam` gets "Add practice". Games open the
 * game detail, practices the practice detail.
 *
 * Games come from `GET /games?teamId&startDate&endDate` (newest first, one
 * page of 100), practices from `GET /practices?teamId&from&to` (ascending,
 * one page of 200); both are the API's maximum pages, and the window keeps a
 * team well inside them. Games are served newest first, so a window wider
 * than a page would lose the soonest ones: that is why the window is bounded
 * rather than paged. `mergeSchedule` flags (and for practices, holds back
 * around) a page that is short of its total.
 */

import React, { useMemo, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  Button,
  LoadingSpinner,
  ErrorState,
  EmptyState,
} from '../../../components';
import { BackButton } from '../../../components/BackButton';
import { useGamesPage } from '../../../hooks/useGames';
import { usePractices } from '../../../hooks/usePractices';
import { useTeam, hasTeamPermission } from '../../../hooks/useTeams';
import { useGoBack } from '../../../hooks/useGoBack';
import { useTheme } from '../../../hooks/useTheme';
import { useAuthUser } from '../../../store/auth-store';
import { useTranslation, i18n } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { formatClockTime, formatShortDate } from '../../../utils/format-date';
import {
  SCHEDULE_WINDOW_DAYS,
  mergeSchedule,
  practiceTitle,
  formatPracticeTimeRange,
  type ScheduleItem,
} from '../../../utils/practice-schedule';
import type { GameStatus } from '../../../types/game';

/** The most games one schedule load asks for (the API's maximum page). */
const SCHEDULE_GAMES_LIMIT = 100;
/** The most practices one schedule load asks for (the API's maximum page). */
const SCHEDULE_PRACTICES_LIMIT = 200;

function gameStatusLabel(status: GameStatus): string {
  switch (status) {
    case 'IN_PROGRESS':
      return i18n.t('games.statusLive');
    case 'FINISHED':
      return i18n.t('games.statusFinal');
    case 'CANCELLED':
      return i18n.t('games.cancelled');
    default:
      return i18n.t('games.scheduled');
  }
}

/** Midnight at the start of the device's today, and the end of the window, as ISO instants. */
function scheduleWindow(): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + SCHEDULE_WINDOW_DAYS);
  return { from: start.toISOString(), to: end.toISOString() };
}

export default function TeamScheduleScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = useGoBack(`/teams/${id}`);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const user = useAuthUser();

  // Held in state so the query keys stay stable between renders; a refresh on
  // a later day moves it (a screen left open overnight).
  const [{ from, to }, setWindow] = useState(scheduleWindow);
  const { data: team } = useTeam(id);
  const gamesQuery = useGamesPage({ teamId: id, startDate: from, endDate: to, limit: SCHEDULE_GAMES_LIMIT });
  const practicesQuery = usePractices({ teamId: id, from, to, limit: SCHEDULE_PRACTICES_LIMIT });

  const canManageTeam = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);

  const { items, truncated } = useMemo(
    () =>
      mergeSchedule(
        gamesQuery.data?.games ?? [],
        gamesQuery.data?.total ?? 0,
        practicesQuery.data?.practices ?? [],
        practicesQuery.data?.total ?? 0
      ),
    [gamesQuery.data, practicesQuery.data]
  );

  const refetchAll = () => {
    const next = scheduleWindow();
    if (next.from !== from) {
      // New keys: both queries load the new window.
      setWindow(next);
      return;
    }
    gamesQuery.refetch();
    practicesQuery.refetch();
  };

  const loading = gamesQuery.isLoading || practicesQuery.isLoading;
  const failed = (gamesQuery.error && !gamesQuery.data) || (practicesQuery.error && !practicesQuery.data);

  if (loading) {
    return <LoadingSpinner message={t('practices.loadingSchedule')} fullScreen />;
  }
  const loadError = gamesQuery.error ?? practicesQuery.error;
  if (failed) {
    return (
      <ErrorState
        message={loadError instanceof Error ? loadError.message : t('practices.scheduleLoadFailed')}
        onRetry={refetchAll}
        onBack={goBack}
      />
    );
  }

  const addPractice = () => router.push(`/practices/create?teamId=${id}`);

  const renderItem = ({ item }: { item: ScheduleItem }) => {
    if (item.kind === 'game') {
      const { game } = item;
      const title = t('practices.gameVs', { opponent: game.opponent });
      const when = `${formatShortDate(game.date)} · ${formatClockTime(game.date)}`;
      const status = gameStatusLabel(game.status);
      return (
        <Card
          variant="default"
          onPress={() => router.push(`/games/${game.id}`)}
          accessibilityLabel={[title, when, status].join(', ')}
          testID={`schedule-game-${game.id}`}
        >
          <View style={styles.row}>
            <Ionicons name="basketball-outline" size={22} color={colors.primary} />
            <View style={styles.rowText}>
              <ThemedText variant="bodyBold" numberOfLines={1}>
                {title}
              </ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {when}
              </ThemedText>
            </View>
            <ThemedText variant="footnote" color="textTertiary">
              {status}
            </ThemedText>
          </View>
        </Card>
      );
    }

    const { practice } = item;
    const cancelled = practice.status === 'CANCELLED';
    const recurring = practice.seriesId !== null;
    const title = practiceTitle(practice);
    const when = `${formatShortDate(practice.startsAt, { timeZone: practice.timezone })} · ${formatPracticeTimeRange(practice)}`;
    const label = [
      title,
      when,
      practice.location ?? null,
      recurring ? t('practices.recurring') : null,
      cancelled ? t('practices.cancelled') : null,
    ]
      .filter(Boolean)
      .join(', ');
    return (
      <Card
        variant="default"
        onPress={() => router.push(`/practices/${practice.id}`)}
        accessibilityLabel={label}
        testID={`schedule-practice-${practice.id}`}
      >
        <View style={[styles.row, cancelled && styles.cancelledRow]}>
          <Ionicons
            name={practice.type === 'OTHER' ? 'calendar-outline' : 'fitness-outline'}
            size={22}
            color={cancelled ? colors.textTertiary : colors.primary}
          />
          <View style={styles.rowText}>
            <View style={styles.titleLine}>
              <ThemedText
                variant="bodyBold"
                numberOfLines={1}
                style={[styles.flexShrink, cancelled && styles.strike]}
              >
                {title}
              </ThemedText>
              {recurring ? <Ionicons name="repeat" size={16} color={colors.textSecondary} /> : null}
            </View>
            <ThemedText variant="caption" color="textSecondary">
              {when}
            </ThemedText>
            {practice.location ? (
              <ThemedText variant="caption" color="textTertiary" numberOfLines={1}>
                {practice.location}
              </ThemedText>
            ) : null}
          </View>
          {cancelled ? (
            <View style={[styles.badge, { backgroundColor: colors.error + '20' }]}>
              <ThemedText variant="footnote" color="error">
                {t('practices.cancelled')}
              </ThemedText>
            </View>
          ) : null}
        </View>
      </Card>
    );
  };

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + spacing.sm, paddingHorizontal: padding, borderBottomColor: colors.border },
        ]}
      >
        <BackButton onPress={goBack} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h3" heading numberOfLines={1}>
            {t('practices.scheduleTitle')}
          </ThemedText>
          {team ? (
            <ThemedText variant="caption" color="textSecondary" numberOfLines={1}>
              {team.name}
            </ThemedText>
          ) : null}
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => `${item.kind}-${item.id}`}
        renderItem={renderItem}
        contentContainerStyle={[
          styles.list,
          { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={gamesQuery.isRefetching || practicesQuery.isRefetching}
            onRefresh={refetchAll}
          />
        }
        ListHeaderComponent={
          canManageTeam ? (
            <Button
              title={t('practices.addPractice')}
              onPress={addPractice}
              variant="primary"
              style={styles.addButton}
              testID="schedule-add-practice"
            />
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon="calendar-outline"
            title={t('practices.emptyTitle')}
            message={canManageTeam ? t('practices.emptyCoach') : t('practices.emptyMember')}
          />
        }
        ListFooterComponent={
          <ThemedText variant="footnote" color="textTertiary" style={styles.footer}>
            {truncated
              ? `${t('practices.windowNote', { days: SCHEDULE_WINDOW_DAYS })} ${t('practices.truncated')}`
              : t('practices.windowNote', { days: SCHEDULE_WINDOW_DAYS })}
          </ThemedText>
        }
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { marginLeft: -spacing.xs },
  headerContent: { flex: 1, marginLeft: spacing.sm },
  list: { paddingTop: spacing.lg },
  addButton: { marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cancelledRow: { opacity: 0.7 },
  rowText: { flex: 1, gap: spacing.xxs },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  flexShrink: { flexShrink: 1 },
  strike: { textDecorationLine: 'line-through' },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: borderRadius.sm,
  },
  footer: { textAlign: 'center', marginTop: spacing.md },
});
