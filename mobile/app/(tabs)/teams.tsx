/**
 * Teams list screen with color-header team cards
 */

import React from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  LoadingSpinner,
  EmptyState,
  ErrorState,
  Button,
} from '../../components';
import { useInfiniteTeams, type Team } from '../../hooks/useTeams';
import { useToast } from '../../components/Toast';
import { useQueryErrorState } from '../../hooks/useQueryErrorState';
import { useTheme } from '../../hooks/useTheme';
import { useTabBarPadding } from '../../hooks/useTabBarPadding';
import { useTranslation } from '../../i18n';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { getTeamColor } from '../../utils/team-colors';
import { canCreateTeams } from '../../utils/team-permissions';
import { useAuthUser } from '../../store/auth-store';

export default function TeamsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const tabBarPadding = useTabBarPadding();
  const user = useAuthUser();
  const canCreate = canCreateTeams(user);
  const toast = useToast();

  const {
    data,
    isLoading,
    error,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteTeams();
  const teams = data?.teams;

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      fetchNextPage();
    }
  };

  const handleCreateTeam = () => {
    router.push('/teams/create');
  };

  const handleTeamPress = (teamId: string) => {
    router.push(`/teams/${teamId}`);
  };

  // `user` is null while the persisted session rehydrates; don't render the
  // player empty state (no Create button) for a coach who simply isn't
  // loaded yet.
  // A failed first load replaces the screen; a failed background refetch keeps the
  // cached list (#888, hooks/useQueryErrorState.ts).
  const errorState = useQueryErrorState(
    { error, data: teams, refetch, onRefreshError: (m) => toast.showToast(m, 'error') },
    t('teams.loadFailed')
  );

  if (isLoading || !user || errorState.retrying) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (errorState.failed) {
    return <ErrorState message={errorState.message} onRetry={errorState.retry} />;
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
          <ThemedText variant="h1" heading>{t('teams.title')}</ThemedText>
        </View>
        {canCreate ? (
          <EmptyState
            icon="people-outline"
            title={t('teams.noTeams')}
            message={t('teams.firstTeamHint')}
            actionLabel={t('teams.createNew')}
            onAction={handleCreateTeam}
          />
        ) : (
          <EmptyState
            icon="people-outline"
            title={t('teams.noTeams')}
            message={t('teams.playerEmptyMessage')}
            actionLabel={t('teams.playerEmptyAction')}
            onAction={() => router.push('/onboarding/role?from=profile')}
          />
        )}
      </ThemedView>
    );
  }

  // Players never see the create card — the API refuses them (403) anyway.
  const dataWithCreate = canCreate ? [...teams, { id: '__create__', name: '' } as Team] : teams;

  const renderTeam = ({ item }: { item: Team }) => {
    if (item.id === '__create__') {
      return (
        <TouchableOpacity
          onPress={handleCreateTeam}
          style={[styles.teamCard, styles.createCard, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={t('teams.createNewA11y')}
        >
          <View style={styles.createCardContent}>
            <Ionicons name="add-circle-outline" size={36} color={colors.textTertiary} />
            <ThemedText variant="captionBold" color="textSecondary">
              {t('teams.create')}
            </ThemedText>
          </View>
        </TouchableOpacity>
      );
    }

    const teamColor = getTeamColor(item.name);
    const memberCount = item._count?.members ?? item.members?.length ?? 0;
    const leagueName = item.season?.league?.name || t('teams.noLeague');

    return (
      <TouchableOpacity
        onPress={() => handleTeamPress(item.id)}
        activeOpacity={0.8}
        style={[styles.teamCard, { backgroundColor: colors.backgroundSecondary }]}
        accessibilityRole="button"
        accessibilityLabel={item.name}
      >
        <View style={[styles.teamColorHeader, { backgroundColor: teamColor }]}>
          <ThemedText variant="h1" heading={false} /* avatar initial */ style={styles.teamInitial}>
            {item.name.charAt(0).toUpperCase()}
          </ThemedText>
        </View>
        <View style={styles.teamInfoSection}>
          <ThemedText variant="bodyBold" numberOfLines={1}>
            {item.name}
          </ThemedText>
          <ThemedText variant="footnote" color="textSecondary" numberOfLines={1}>
            {leagueName}
          </ThemedText>
          <View style={styles.playerCountRow}>
            <Ionicons name="people-outline" size={12} color={colors.textTertiary} />
            <ThemedText variant="footnote" color="textTertiary">
              {t('teams.playerCount', { count: memberCount })}
            </ThemedText>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingHorizontal: padding, paddingTop: insets.top + spacing.md },
        ]}
      >
        <ThemedText variant="h1" heading>{t('teams.title')}</ThemedText>
      </View>

      <FlatList
        data={dataWithCreate}
        renderItem={renderTeam}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingHorizontal: padding,
          paddingTop: spacing.md,
          paddingBottom: tabBarPadding,
        }}
        numColumns={2}
        columnWrapperStyle={styles.row}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <LoadingSpinner message={t('common.loading')} />
          ) : isFetchNextPageError ? (
            <Button
              title={t('common.loadMoreFailed')}
              variant="ghost"
              onPress={() => fetchNextPage()}
            />
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={errorState.refresh}
            tintColor={colors.primary}
          />
        }
        key={2}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingBottom: spacing.sm },
  row: { justifyContent: 'space-between', marginBottom: spacing.md },
  teamCard: { width: '48%', borderRadius: borderRadius.md, overflow: 'hidden' },
  teamColorHeader: {
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamInitial: { color: '#FFFFFF', fontSize: 36, fontWeight: '700' },
  teamInfoSection: { padding: spacing.sm, gap: spacing.xxs },
  playerCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    marginTop: spacing.xxs,
  },
  createCard: {
    borderWidth: 2,
    borderStyle: 'dashed',
    height: 150,
    justifyContent: 'center',
    alignItems: 'center',
  },
  createCardContent: { alignItems: 'center', gap: spacing.sm },
});
