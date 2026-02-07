/**
 * League Detail screen - View and manage seasons
 */

import React from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
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
  LoadingSpinner,
  EmptyState,
  ErrorState,
  Button,
} from '../../../components';
import { useLeague, useDeleteLeague } from '../../../hooks/useLeagues';
import { useSeasons, Season } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';

export default function LeagueDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: league, isLoading: leagueLoading, error: leagueError, refetch: refetchLeague } = useLeague(id);
  const { data: seasonsData, isLoading: seasonsLoading, refetch: refetchSeasons, isRefetching } = useSeasons({ leagueId: id });
  const deleteLeague = useDeleteLeague();

  const seasons = seasonsData?.seasons || [];

  const handleCreateSeason = () => {
    router.push(`/admin/seasons/create?leagueId=${id}`);
  };

  const handleSeasonPress = (seasonId: string) => {
    // Could navigate to season detail in the future
    Alert.alert('Season', 'Season detail view coming soon');
  };

  const handleDeleteLeague = () => {
    if (seasons.length > 0) {
      Alert.alert(
        'Cannot Delete',
        'This league has seasons. Delete all seasons first before deleting the league.'
      );
      return;
    }

    Alert.alert(
      'Delete League',
      `Are you sure you want to delete "${league?.name}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteLeague.mutateAsync(id);
              Alert.alert('Success', 'League deleted successfully', [
                { text: 'OK', onPress: () => router.replace('/admin') },
              ]);
            } catch (error) {
              Alert.alert(
                'Error',
                error instanceof Error ? error.message : 'Failed to delete league'
              );
            }
          },
        },
      ]
    );
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
        onPress={() => handleSeasonPress(item.id)}
        style={styles.seasonCard}
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

  if (leagueLoading || seasonsLoading) {
    return <LoadingSpinner message="Loading league..." fullScreen />;
  }

  if (leagueError || !league) {
    return (
      <ErrorState
        message={leagueError instanceof Error ? leagueError.message : 'League not found'}
        onRetry={refetch}
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
        <TouchableOpacity
          onPress={handleDeleteLeague}
          style={styles.deleteButton}
          accessibilityRole="button"
          accessibilityLabel="Delete league"
        >
          <Ionicons name="trash-outline" size={22} color={colors.error} />
        </TouchableOpacity>
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
    borderRadius: 20,
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
    borderRadius: 10,
  },
});
