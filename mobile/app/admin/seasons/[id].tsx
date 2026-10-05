/**
 * Season Detail screen (#614): the season's name, dates, active state and
 * teams, with Edit and Delete. Reached from the league screen (Profile →
 * Leagues & Seasons → league → season).
 *
 * Gating mirrors the server: viewing and editing need system ADMIN or admin of
 * the season's league (`season-service.updateSeason` → `isLeagueAdmin`);
 * deleting stays ADMIN-only (`deleteSeason` → `isSystemAdmin`). The API is the
 * authority either way (403).
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  LoadingSpinner,
  EmptyState,
  ErrorState,
  ActionMenu,
} from '../../../components';
import { useToast } from '../../../components/Toast';
import { useSeason, useDeleteSeason, Season } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useGoBack } from '../../../hooks/useGoBack';
import { useAuthUser } from '../../../store/auth-store';
import { canCreateLeagues, canManageLeague } from '../../../utils/team-permissions';
import { getApiErrorMessage } from '../../../services/api-client';
import { useTranslation } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { MIN_TOUCH_TARGET } from '../../../utils/touch-target';
import { BackButton } from '../../../components/BackButton';

/** "Mar 1, 2024 - Jun 30, 2024", with a placeholder for a missing end. */
export function formatSeasonRange(
  season: Pick<Season, 'startDate' | 'endDate'>,
  labels: { noStart: string; noEnd: string }
): string | null {
  if (!season.startDate && !season.endDate) return null;
  const start = season.startDate ? new Date(season.startDate).toLocaleDateString() : labels.noStart;
  const end = season.endDate ? new Date(season.endDate).toLocaleDateString() : labels.noEnd;
  return `${start} - ${end}`;
}

export default function SeasonDetailScreen() {
  const router = useRouter();
  const goBack = useGoBack('/admin');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const { data: season, isLoading, error, refetch, isRefetching } = useSeason(id);
  const deleteSeason = useDeleteSeason();
  // After a delete: pop back to the league screen that opened this one, or land
  // on the league when there is nothing to pop (deep link). A `replace` here
  // would leave two league screens on the stack.
  const backToLeague = useGoBack(season ? `/admin/leagues/${season.leagueId}` : '/admin');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // The league id comes from the loaded season, so the guard is ready only
  // once the season is here. An unaffiliated caller never gets that far: the
  // server answers 404 and the ErrorState below shows it.
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user && !!season,
    canManageLeague(user, season?.leagueId),
    t('seasons.manageNotAllowed'),
    { fallback: '/admin' }
  );
  const canDelete = canCreateLeagues(user);

  const handleDelete = async () => {
    if (!season) return;
    try {
      await deleteSeason.mutateAsync(season.id);
      toast.showToast(t('seasons.deleteSuccess'), 'success');
      backToLeague();
    } catch (err) {
      // A 400 (the season still has teams) carries the server's reason.
      toast.showToast(getApiErrorMessage(err, t('seasons.deleteFailed')), 'error');
    }
  };

  if (isLoading || (season && !allowed)) {
    return <LoadingSpinner message={t('seasons.loading')} fullScreen />;
  }

  if (error || !season) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('seasons.notFound')}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }

  const teams = season.teams ?? [];
  const teamCount = season._count?.teams ?? teams.length;
  const dateRange = formatSeasonRange(season, {
    noStart: t('seasons.noStart'),
    noEnd: t('seasons.noEnd'),
  });

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: padding,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <BackButton onPress={goBack} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" numberOfLines={1}>{season.name}</ThemedText>
          {season.league && (
            <ThemedText variant="caption" color="textSecondary" numberOfLines={1}>
              {season.league.name}
            </ThemedText>
          )}
        </View>
        <TouchableOpacity
          onPress={() => router.push(`/admin/seasons/${season.id}/edit`)}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={t('seasons.edit')}
          testID="season-edit-button"
        >
          <Ionicons name="create-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
        {canDelete && (
          <TouchableOpacity
            onPress={() => setConfirmingDelete(true)}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={t('seasons.delete')}
            testID="season-delete-button"
          >
            <Ionicons name="trash-outline" size={22} color={colors.error} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
        }
      >
        <Card variant="elevated" style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <View
              style={[
                styles.badge,
                { backgroundColor: (season.isActive ? colors.success : colors.textTertiary) + '20' },
              ]}
              accessibilityLabel={season.isActive ? t('seasons.active') : t('seasons.inactive')}
            >
              <ThemedText
                variant="captionBold"
                style={{ color: season.isActive ? colors.success : colors.textSecondary }}
              >
                {season.isActive ? t('seasons.active') : t('seasons.inactive')}
              </ThemedText>
            </View>
            <ThemedText variant="body" color="textSecondary">
              {t('seasons.teamCount', { count: teamCount })}
            </ThemedText>
          </View>
          {dateRange && (
            <View style={styles.dateRow}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <ThemedText variant="body" color="textSecondary">{dateRange}</ThemedText>
            </View>
          )}
        </Card>

        <ThemedText variant="h3" style={styles.sectionTitle}>
          {t('seasons.teams')}
        </ThemedText>
        {teams.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title={t('seasons.noTeams')}
            message={t('seasons.noTeamsMessage')}
          />
        ) : (
          teams.map((team) => (
            <Card
              key={team.id}
              variant="elevated"
              style={styles.teamCard}
              onPress={() => router.push(`/teams/${team.id}`)}
              accessibilityLabel={team.name}
            >
              <View style={styles.teamRow}>
                <ThemedText variant="h4" style={styles.teamName} numberOfLines={1}>
                  {team.name}
                </ThemedText>
                <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      <ActionMenu
        visible={confirmingDelete}
        title={t('seasons.deleteConfirmTitle', { name: season.name })}
        items={[{ label: t('common.delete'), destructive: true, onPress: handleDelete }]}
        onClose={() => setConfirmingDelete(false)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
  // Edit and delete sit side by side with no gap, so they grow to 44pt
  // rather than take hitSlop (overlapping slop would hand one the other's taps).
  iconButton: {
    padding: spacing.sm,
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerContent: {
    flex: 1,
  },
  content: {
    paddingTop: spacing.lg,
  },
  summaryCard: {
    marginBottom: spacing.lg,
    gap: spacing.md,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionTitle: {
    marginBottom: spacing.md,
  },
  teamCard: {
    marginBottom: spacing.md,
  },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  teamName: {
    flex: 1,
  },
});
