/**
 * Teams list screen
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
import { ThemedView, ThemedText, Card, LoadingSpinner, EmptyState, ErrorState } from '../../components';
import { useTeams } from '../../hooks/useTeams';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing } from '../../theme';
import { getHorizontalPadding, getResponsiveValue } from '../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { Team } from '../../hooks/useTeams';

export default function TeamsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const columns = getResponsiveValue(1, 2);

  const {
    data: teams,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useTeams();

  const handleCreateTeam = () => {
    router.push('/teams/create');
  };

  const handleTeamPress = (teamId: string) => {
    router.push(`/teams/${teamId}`);
  };

  if (isLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load teams'}
        onRetry={refetch}
      />
    );
  }

  if (!teams || teams.length === 0) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={[styles.header, { paddingHorizontal: padding }]}>
          <ThemedText variant="h1">{t('teams.title')}</ThemedText>
          <TouchableOpacity
            onPress={handleCreateTeam}
            style={[styles.createButton, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="add" size={24} color={colors.textInverse} />
          </TouchableOpacity>
        </View>
        <EmptyState
          icon="people-outline"
          title={t('teams.noTeams')}
          message="Create your first team to get started"
          actionLabel={t('teams.createNew')}
          onAction={handleCreateTeam}
        />
      </ThemedView>
    );
  }

  const renderTeam = ({ item }: { item: Team }) => {
    const memberCount = item.members?.length || 0;
    const leagueName = item.league?.name || 'No League';

    return (
      <Card
        variant="elevated"
        onPress={() => handleTeamPress(item.id)}
        style={[
          styles.teamCard,
          {
            width: columns === 2 ? '48%' : '100%',
          },
        ]}
      >
        <View style={styles.teamHeader}>
          <ThemedText variant="h4">{item.name}</ThemedText>
          <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
        </View>
        <View style={styles.teamInfo}>
          <View style={styles.infoRow}>
            <Ionicons name="trophy-outline" size={16} color={colors.textTertiary} />
            <ThemedText variant="caption" color="textSecondary" style={styles.infoText}>
              {leagueName}
            </ThemedText>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="people-outline" size={16} color={colors.textTertiary} />
            <ThemedText variant="caption" color="textSecondary" style={styles.infoText}>
              {memberCount} {memberCount === 1 ? 'player' : 'players'}
            </ThemedText>
          </View>
        </View>
      </Card>
    );
  };

  return (
    <ThemedView variant="background" style={styles.container}>
      <View style={[styles.header, { paddingHorizontal: padding }]}>
        <ThemedText variant="h1">{t('teams.title')}</ThemedText>
        <TouchableOpacity
          onPress={handleCreateTeam}
          style={[styles.createButton, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="add" size={24} color={colors.textInverse} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={teams}
        renderItem={renderTeam}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingHorizontal: padding,
            paddingTop: spacing.md,
          },
        ]}
        numColumns={columns}
        columnWrapperStyle={columns === 2 ? styles.row : undefined}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
        key={columns} // Force re-render when columns change
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  createButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  row: {
    justifyContent: 'space-between',
  },
  teamCard: {
    marginBottom: 0,
  },
  teamHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  teamInfo: {
    gap: spacing.xs,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  infoText: {
    marginLeft: 4,
  },
});
