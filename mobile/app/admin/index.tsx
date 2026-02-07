/**
 * Admin Dashboard - Manage leagues and seasons
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
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  LoadingSpinner,
  EmptyState,
  ErrorState,
} from '../../components';
import { useLeagues, League } from '../../hooks/useLeagues';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

export default function AdminDashboard() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const {
    data: leagues,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useLeagues();

  const handleCreateLeague = () => {
    router.push('/admin/leagues/create');
  };

  const handleLeaguePress = (leagueId: string) => {
    router.push(`/admin/leagues/${leagueId}`);
  };

  const renderLeague = ({ item }: { item: League }) => {
    const seasonCount = item._count?.seasons || item.seasons?.length || 0;

    return (
      <Card
        variant="elevated"
        onPress={() => handleLeaguePress(item.id)}
        style={styles.leagueCard}
      >
        <View style={styles.leagueHeader}>
          <View style={styles.leagueInfo}>
            <ThemedText variant="h4">{item.name}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">
              {seasonCount} {seasonCount === 1 ? 'season' : 'seasons'}
            </ThemedText>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
        </View>
        {item.seasons && item.seasons.length > 0 && (
          <View style={styles.seasonsPreview}>
            {item.seasons.slice(0, 2).map((season) => (
              <View
                key={season.id}
                style={[
                  styles.seasonChip,
                  {
                    backgroundColor: season.isActive
                      ? colors.success + '20'
                      : colors.textTertiary + '20',
                  },
                ]}
              >
                <ThemedText
                  variant="caption"
                  style={{
                    color: season.isActive ? colors.success : colors.textTertiary,
                  }}
                >
                  {season.name}
                </ThemedText>
              </View>
            ))}
            {item.seasons.length > 2 && (
              <ThemedText variant="caption" color="textTertiary">
                +{item.seasons.length - 2} more
              </ThemedText>
            )}
          </View>
        )}
      </Card>
    );
  };

  if (isLoading) {
    return <LoadingSpinner message="Loading leagues..." fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load leagues'}
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
          <ThemedText variant="h2">League Management</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            Create and manage leagues and seasons
          </ThemedText>
        </View>
        <TouchableOpacity
          onPress={handleCreateLeague}
          style={[styles.addButton, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="add" size={24} color={colors.textInverse} />
        </TouchableOpacity>
      </View>

      {!leagues || leagues.length === 0 ? (
        <EmptyState
          icon="trophy-outline"
          title="No Leagues"
          message="Create your first league to get started"
          actionLabel="Create League"
          onAction={handleCreateLeague}
        />
      ) : (
        <FlatList
          data={leagues}
          renderItem={renderLeague}
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
    gap: spacing.sm,
  },
  backButton: {
    padding: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  leagueCard: {
    marginBottom: spacing.md,
  },
  leagueHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  leagueInfo: {
    flex: 1,
  },
  seasonsPreview: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  seasonChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 12,
  },
});
