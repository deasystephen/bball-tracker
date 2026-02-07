/**
 * Games screen - list of games with status filters
 */

import React, { useCallback, useState, useMemo } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  EmptyState,
  LoadingSpinner,
  ErrorState,
} from '../../components';
import { GameCard } from '../../components/game';
import { useGames } from '../../hooks/useGames';
import { useTheme } from '../../hooks/useTheme';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import type { Game, GameStatus } from '../../types/game';

type FilterTab = 'ALL' | GameStatus;

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'IN_PROGRESS', label: 'Live' },
  { key: 'SCHEDULED', label: 'Upcoming' },
  { key: 'FINISHED', label: 'Completed' },
];

const keyExtractor = (item: Game): string => item.id;

export default function Games() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const [activeFilter, setActiveFilter] = useState<FilterTab>('ALL');

  const {
    data: games,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useGames();

  const filteredGames = useMemo(() => {
    if (!games) return [];
    if (activeFilter === 'ALL') return games;
    return games.filter((g) => g.status === activeFilter);
  }, [games, activeFilter]);

  const handleGamePress = useCallback(
    (game: Game) => {
      router.push(`/games/${game.id}`);
    },
    [router]
  );

  const handleCreateGame = useCallback(() => {
    router.push('/games/create');
  }, [router]);

  const renderGame = useCallback(
    ({ item }: { item: Game }) => {
      const isLive = item.status === 'IN_PROGRESS';
      const isUpcoming = item.status === 'SCHEDULED';
      const isCompleted = item.status === 'FINISHED';

      if (isLive) {
        return (
          <TouchableOpacity
            onPress={() => handleGamePress(item)}
            activeOpacity={0.85}
            style={[
              styles.liveGameCard,
              {
                backgroundColor: colors.primaryDark,
                borderColor: colors.accent,
              },
            ]}
          >
            <View style={styles.liveHeader}>
              <View
                style={[styles.liveBadge, { backgroundColor: colors.live }]}
              >
                <View style={styles.livePulse} />
                <ThemedText variant="footnote" style={styles.liveBadgeText}>
                  LIVE
                </ThemedText>
              </View>
            </View>
            <View style={styles.liveScoreSection}>
              <View style={styles.liveTeamCol}>
                <ThemedText
                  variant="caption"
                  style={styles.liveTeamName}
                  numberOfLines={1}
                >
                  {item.team?.name || 'Home'}
                </ThemedText>
                <ThemedText variant="h1" style={styles.liveScoreNum}>
                  {item.homeScore}
                </ThemedText>
              </View>
              <ThemedText variant="h3" style={styles.liveVs}>
                -
              </ThemedText>
              <View style={styles.liveTeamCol}>
                <ThemedText
                  variant="caption"
                  style={styles.liveTeamName}
                  numberOfLines={1}
                >
                  {item.opponent}
                </ThemedText>
                <ThemedText variant="h1" style={styles.liveScoreNum}>
                  {item.awayScore}
                </ThemedText>
              </View>
            </View>
          </TouchableOpacity>
        );
      }

      if (isUpcoming) {
        const gameDate = new Date(item.date);
        const month = gameDate
          .toLocaleDateString(undefined, { month: 'short' })
          .toUpperCase();
        const day = gameDate.getDate();
        return (
          <TouchableOpacity
            onPress={() => handleGamePress(item)}
            activeOpacity={0.7}
          >
            <Card variant="elevated" style={styles.upcomingCard}>
              <View style={styles.upcomingRow}>
                <View
                  style={[
                    styles.calendarChip,
                    { backgroundColor: colors.info + '15' },
                  ]}
                >
                  <ThemedText
                    variant="footnote"
                    style={{ color: colors.info, fontWeight: '700' }}
                  >
                    {month}
                  </ThemedText>
                  <ThemedText variant="h3" style={{ color: colors.info }}>
                    {day}
                  </ThemedText>
                </View>
                <View style={styles.upcomingInfo}>
                  <ThemedText variant="bodyBold" numberOfLines={1}>
                    vs {item.opponent}
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {item.team?.name || 'TBD'}
                  </ThemedText>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={colors.textTertiary}
                />
              </View>
            </Card>
          </TouchableOpacity>
        );
      }

      if (isCompleted) {
        const isWin = item.homeScore > item.awayScore;
        return (
          <TouchableOpacity
            onPress={() => handleGamePress(item)}
            activeOpacity={0.7}
          >
            <Card variant="elevated" style={styles.completedCard}>
              <View style={styles.completedRow}>
                <View
                  style={[
                    styles.wlStripe,
                    {
                      backgroundColor: isWin ? colors.success : colors.error,
                    },
                  ]}
                />
                <View style={styles.completedInfo}>
                  <ThemedText variant="caption" color="textSecondary">
                    vs {item.opponent}
                  </ThemedText>
                  <View style={styles.completedScoreRow}>
                    <ThemedText variant="h3">
                      {item.homeScore} - {item.awayScore}
                    </ThemedText>
                    <ThemedText
                      variant="captionBold"
                      style={{
                        color: isWin ? colors.success : colors.error,
                        marginLeft: spacing.sm,
                      }}
                    >
                      {isWin ? 'W' : 'L'}
                    </ThemedText>
                  </View>
                  <ThemedText variant="footnote" color="textTertiary">
                    {new Date(item.date).toLocaleDateString()}
                  </ThemedText>
                </View>
              </View>
            </Card>
          </TouchableOpacity>
        );
      }

      return <GameCard game={item} onPress={() => handleGamePress(item)} />;
    },
    [handleGamePress, colors]
  );

  if (isLoading) {
    return <LoadingSpinner message="Loading games..." fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={
          error instanceof Error ? error.message : 'Failed to load games'
        }
        onRetry={refetch}
      />
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingHorizontal: padding, paddingTop: insets.top + spacing.md },
        ]}
      >
        <ThemedText variant="h1">Games</ThemedText>
      </View>

      {/* Filter Tabs */}
      <View style={[styles.filterContainer, { paddingHorizontal: padding }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {FILTER_TABS.map((tab) => {
            const isActive = activeFilter === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setActiveFilter(tab.key)}
                style={[
                  styles.filterPill,
                  {
                    backgroundColor: isActive
                      ? colors.primary
                      : colors.backgroundSecondary,
                    borderColor: isActive ? colors.primary : colors.border,
                  },
                ]}
              >
                <ThemedText
                  variant="captionBold"
                  style={{
                    color: isActive ? '#FFFFFF' : colors.textSecondary,
                  }}
                >
                  {tab.label}
                </ThemedText>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {filteredGames.length > 0 ? (
        <FlatList
          data={filteredGames}
          renderItem={renderGame}
          keyExtractor={keyExtractor}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: padding },
          ]}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={5}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
        />
      ) : (
        <EmptyState
          icon="basketball-outline"
          title="No Games"
          message={
            activeFilter === 'ALL'
              ? 'Create your first game to start tracking stats and scores.'
              : `No ${FILTER_TABS.find((t) => t.key === activeFilter)?.label.toLowerCase()} games.`
          }
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary }]}
        onPress={handleCreateGame}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Create new game"
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </TouchableOpacity>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingBottom: spacing.sm },
  filterContainer: { paddingBottom: spacing.md },
  filterRow: { flexDirection: 'row', gap: spacing.sm },
  filterPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  listContent: { paddingBottom: spacing.xxl * 2 },
  liveGameCard: {
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
  },
  liveHeader: { flexDirection: 'row', marginBottom: spacing.md },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  livePulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  liveBadgeText: { color: '#FFFFFF', fontWeight: '700' },
  liveScoreSection: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  liveTeamCol: { alignItems: 'center', flex: 1 },
  liveTeamName: { color: 'rgba(255,255,255,0.7)', marginBottom: spacing.xs },
  liveScoreNum: { color: '#FFFFFF', fontSize: 36, lineHeight: 42 },
  liveVs: { color: 'rgba(255,255,255,0.5)' },
  upcomingCard: { marginBottom: spacing.sm },
  upcomingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  calendarChip: {
    width: 52,
    height: 56,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  upcomingInfo: { flex: 1 },
  completedCard: { marginBottom: spacing.sm },
  completedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  wlStripe: { width: 4, height: 48, borderRadius: 2 },
  completedInfo: { flex: 1 },
  completedScoreRow: { flexDirection: 'row', alignItems: 'center' },
  fab: {
    position: 'absolute',
    bottom: spacing.xl + 70,
    right: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
});
