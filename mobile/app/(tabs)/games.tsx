/**
 * Games screen - list of games and ability to track new games
 */

import React from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  EmptyState,
  LoadingSpinner,
  ErrorState,
} from '../../components';
import { GameCard } from '../../components/game';
import { useGames } from '../../hooks/useGames';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import type { Game } from '../../types/game';

export default function Games() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();

  const {
    data: games,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useGames();

  const handleGamePress = (game: Game) => {
    router.push(`/games/${game.id}`);
  };

  const handleCreateGame = () => {
    router.push('/games/create');
  };

  const renderGame = ({ item }: { item: Game }) => (
    <GameCard game={item} onPress={() => handleGamePress(item)} />
  );

  if (isLoading) {
    return <LoadingSpinner message="Loading games..." fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load games'}
        onRetry={refetch}
      />
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      <View style={[styles.header, { paddingHorizontal: padding }]}>
        <ThemedText variant="h1">Games</ThemedText>
      </View>

      {games && games.length > 0 ? (
        <FlatList
          data={games}
          renderItem={renderGame}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.listContent,
            { paddingHorizontal: padding },
          ]}
          showsVerticalScrollIndicator={false}
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
          title="No Games Scheduled"
          message="Create your first game to start tracking stats and scores."
        />
      )}

      {/* Floating Action Button */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary }]}
        onPress={handleCreateGame}
        activeOpacity={0.8}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </TouchableOpacity>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  listContent: {
    paddingBottom: spacing.xxl * 2,
  },
  fab: {
    position: 'absolute',
    bottom: spacing.xl,
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
