/**
 * League Detail screen - View and manage seasons
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
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
  EmptyState,
  ErrorState,
  ActionMenu,
} from '../../../components';
import { useToast } from '../../../components/Toast';
import { useLeague, useDeleteLeague } from '../../../hooks/useLeagues';
import { useSeasons, Season } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { canCreateLeagues, canManageLeague } from '../../../utils/team-permissions';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { useGoBack } from '../../../hooks/useGoBack';
import { getApiErrorMessage } from '../../../services/api-client';
import { useTranslation } from '../../../i18n';

/**
 * The league delete rule, as the API applies it (`league-service.deleteLeague`):
 * a league is deletable while no season has teams; empty seasons cascade.
 * Not "no seasons" — that blocked deletes the server would have accepted (#614).
 */
export function leagueHasTeams(seasons: Pick<Season, '_count' | 'teams'>[]): boolean {
  return seasons.some((season) => (season._count?.teams ?? season.teams?.length ?? 0) > 0);
}

export default function LeagueDetailScreen() {
  const router = useRouter();
  const goBack = useGoBack('/admin');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data: league, isLoading: leagueLoading, error: leagueError, refetch: refetchLeague } = useLeague(id);
  const { data: seasonsData, isLoading: seasonsLoading, refetch: refetchSeasons, isRefetching } = useSeasons({ leagueId: id });
  const deleteLeague = useDeleteLeague();

  // Managing a league (seasons etc.) needs system ADMIN or admin of this
  // league; deleting the league itself stays ADMIN-only on the backend.
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user,
    canManageLeague(user, id),
    'Only admins of this league can manage it',
    { fallback: '/admin' }
  );
  const canDelete = canCreateLeagues(user);

  const seasons = seasonsData?.seasons || [];

  const handleCreateSeason = () => {
    router.push(`/admin/seasons/create?leagueId=${id}`);
  };

  const handleSeasonPress = (season: Season) => {
    router.push(`/admin/seasons/${season.id}`);
  };

  const handleDeleteLeague = () => {
    if (leagueHasTeams(seasons)) {
      toast.showToast(t('leagues.deleteBlockedTeams'), 'error');
      return;
    }
    setConfirmingDelete(true);
  };

  const confirmDeleteLeague = async () => {
    try {
      await deleteLeague.mutateAsync(id);
      toast.showToast(t('leagues.deleteSuccess'), 'success');
      router.replace('/admin');
    } catch (error) {
      toast.showToast(getApiErrorMessage(error, t('leagues.deleteFailed')), 'error');
    }
  };

  const refetch = () => {
    refetchLeague();
    refetchSeasons();
  };

  const renderSeason = ({ item }: { item: Season }) => {
    const teamCount = item._count?.teams || item.teams?.length || 0;
    const dateRange = item.startDate || item.endDate
      ? `${item.startDate ? new Date(item.startDate).toLocaleDateString() : 'No start'} - ${item.endDate ? new Date(item.endDate).toLocaleDateString() : 'No end'}`
      : null;

    return (
      <Card
        variant="elevated"
        onPress={() => handleSeasonPress(item)}
        style={styles.seasonCard}
        accessibilityLabel={item.name}
        testID={`season-row-${item.id}`}
      >
        <View style={styles.seasonHeader}>
          <View style={styles.seasonInfo}>
            <View style={styles.seasonTitleRow}>
              <ThemedText variant="h4">{item.name}</ThemedText>
              {item.isActive && (
                <View style={[styles.activeBadge, { backgroundColor: colors.success + '20' }]}>
                  <ThemedText variant="caption" style={{ color: colors.success }}>
                    Active
                  </ThemedText>
                </View>
              )}
            </View>
            <ThemedText variant="caption" color="textSecondary">
              {teamCount} {teamCount === 1 ? 'team' : 'teams'}
            </ThemedText>
            {dateRange && (
              <ThemedText variant="caption" color="textTertiary">
                {dateRange}
              </ThemedText>
            )}
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
        </View>
      </Card>
    );
  };

  if (leagueLoading || seasonsLoading || !allowed) {
    return <LoadingSpinner message="Loading league..." fullScreen />;
  }

  if (leagueError || !league) {
    return (
      <ErrorState
        message={leagueError instanceof Error ? leagueError.message : 'League not found'}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }

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
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" numberOfLines={1}>{league.name}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {seasons.length} {seasons.length === 1 ? 'season' : 'seasons'}
          </ThemedText>
        </View>
        {canDelete && (
          <TouchableOpacity
            onPress={handleDeleteLeague}
            style={styles.deleteButton}
            accessibilityRole="button"
            accessibilityLabel={t('leagues.deleteLeague')}
            testID="league-delete-button"
          >
            <Ionicons name="trash-outline" size={22} color={colors.error} />
          </TouchableOpacity>
        )}
      </View>

      {/* Seasons List */}
      <View style={[styles.sectionHeader, { paddingHorizontal: padding }]}>
        <ThemedText variant="h3">Seasons</ThemedText>
        <TouchableOpacity
          onPress={handleCreateSeason}
          style={[styles.addSeasonButton, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="add" size={20} color={colors.textInverse} />
          <ThemedText variant="captionBold" style={{ color: colors.textInverse }}>
            Add Season
          </ThemedText>
        </TouchableOpacity>
      </View>

      {seasons.length === 0 ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            icon="calendar-outline"
            title="No Seasons"
            message="Create a season to start adding teams"
            actionLabel="Create Season"
            onAction={handleCreateSeason}
          />
        </View>
      ) : (
        <FlatList
          data={seasons}
          renderItem={renderSeason}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: padding },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
        />
      )}

      <ActionMenu
        visible={confirmingDelete}
        title={t('leagues.deleteConfirmTitle', { name: league.name })}
        items={[{ label: t('common.delete'), destructive: true, onPress: confirmDeleteLeague }]}
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
    gap: spacing.sm,
  },
  backButton: {
    padding: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  deleteButton: {
    padding: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  addSeasonButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  emptyContainer: {
    flex: 1,
  },
  seasonCard: {
    marginBottom: spacing.md,
  },
  seasonHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  seasonInfo: {
    flex: 1,
  },
  seasonTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  activeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
});
