/**
 * Team details screen with hero header
 */

import React from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  Card,
  ListItem,
  LoadingSpinner,
  ErrorState,
  Button,
} from '../../components';
import { useTeam, useDeleteTeam, hasTeamPermission } from '../../hooks/useTeams';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../store/auth-store';
import { getTeamColor } from '../../utils/team-colors';

export default function TeamDetailsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const { user } = useAuthStore();
  const insets = useSafeAreaInsets();

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const deleteTeam = useDeleteTeam();

  const canManageTeam = hasTeamPermission(team, user?.id, 'canManageTeam');
  const canManageRoster = hasTeamPermission(team, user?.id, 'canManageRoster');

  const headCoaches = team?.staff?.filter((s) => s.role.type === 'HEAD_COACH') ?? [];

  const handleDelete = () => {
    Alert.alert(
      'Delete Team',
      'Are you sure you want to delete this team? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTeam.mutateAsync(id);
              Alert.alert('Success', 'Team deleted successfully', [
                { text: 'OK', onPress: () => router.replace('/(tabs)/teams') },
              ]);
            } catch (err) {
              Alert.alert(
                'Error',
                err instanceof Error ? err.message : 'Failed to delete team'
              );
            }
          },
        },
      ]
    );
  };

  if (isLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (error || !team) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Team not found'}
        onRetry={refetch}
      />
    );
  }

  const memberCount = team.members?.length || 0;
  const teamColor = getTeamColor(team.name);

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Team Hero Header */}
      <View style={[styles.heroHeader, { backgroundColor: teamColor, paddingTop: insets.top }]}>
        <View style={[styles.heroNav, { paddingHorizontal: padding }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.heroBackButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
          </TouchableOpacity>
          {canManageTeam && (
            <View style={styles.heroActions}>
              <TouchableOpacity
                onPress={() => router.push(`/teams/${id}/edit`)}
                style={styles.heroIconButton}
                accessibilityLabel="Edit team"
              >
                <Ionicons name="create-outline" size={22} color="#FFFFFF" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleDelete}
                style={styles.heroIconButton}
                accessibilityLabel="Delete team"
              >
                <Ionicons name="trash-outline" size={22} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
          )}
        </View>
        <View style={styles.heroContent}>
          <ThemedText variant="h1" style={styles.heroTeamName}>
            {team.name}
          </ThemedText>
          {headCoaches.length > 0 && (
            <ThemedText variant="caption" style={styles.heroCoach}>
              Coach {headCoaches[0].user.name}
            </ThemedText>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Stats Quick View Row */}
        <View style={styles.statsQuickRow}>
          <TouchableOpacity
            style={[styles.quickStatCard, { backgroundColor: colors.backgroundSecondary }]}
            onPress={() => router.push(`/teams/${id}/stats`)}
          >
            <ThemedText variant="h3">{memberCount}</ThemedText>
            <ThemedText variant="footnote" color="textSecondary">Players</ThemedText>
          </TouchableOpacity>
          <View style={[styles.quickStatCard, { backgroundColor: colors.backgroundSecondary }]}>
            <ThemedText variant="h3" color="primary">--</ThemedText>
            <ThemedText variant="footnote" color="textSecondary">PPG</ThemedText>
          </View>
          <View style={[styles.quickStatCard, { backgroundColor: colors.backgroundSecondary }]}>
            <ThemedText variant="h3" color="primary">--</ThemedText>
            <ThemedText variant="footnote" color="textSecondary">RPG</ThemedText>
          </View>
        </View>

        <Button
          title="View Team Stats"
          onPress={() => router.push(`/teams/${id}/stats`)}
          variant="outline"
          style={styles.statsButton}
        />

        {/* Season/League Info */}
        {team.season && (
          <Card variant="elevated" style={styles.card}>
            <View style={styles.infoRow}>
              <Ionicons name="trophy-outline" size={20} color={colors.primary} />
              <View style={styles.infoContent}>
                <ThemedText variant="caption" color="textSecondary">
                  League & Season
                </ThemedText>
                <ThemedText variant="bodyBold">{team.season.league.name}</ThemedText>
                <ThemedText variant="caption" color="textTertiary">
                  {team.season.name}
                  {team.season.isActive && (
                    <ThemedText variant="caption" color="success"> (Active)</ThemedText>
                  )}
                </ThemedText>
              </View>
            </View>
          </Card>
        )}

        {/* Roster - 2 column grid */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <ThemedText variant="h3">{t('teams.players')}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">
              {memberCount} {memberCount === 1 ? 'player' : 'players'}
            </ThemedText>
          </View>

          {canManageRoster && (
            <Button
              title={t('teams.addPlayer')}
              onPress={() => router.push(`/teams/${id}/players`)}
              variant="primary"
              style={styles.addButton}
            />
          )}

          {team.members && team.members.length > 0 ? (
            <View style={styles.rosterGrid}>
              {team.members.map((member) => (
                <TouchableOpacity
                  key={member.id}
                  style={[styles.rosterCard, { backgroundColor: colors.backgroundSecondary }]}
                  onPress={() => router.push(`/teams/${id}/players/${member.playerId}`)}
                  accessibilityLabel={member.player.name}
                >
                  <View style={[styles.jerseyBadge, { backgroundColor: teamColor + '20' }]}>
                    <ThemedText variant="h3" style={{ color: teamColor }}>
                      {member.jerseyNumber || '-'}
                    </ThemedText>
                  </View>
                  <ThemedText variant="captionBold" numberOfLines={1}>
                    {member.player.name}
                  </ThemedText>
                  {member.position && (
                    <ThemedText variant="footnote" color="textSecondary">
                      {member.position}
                    </ThemedText>
                  )}
                  {member.player.isManaged ? (
                    <ThemedText variant="footnote" color="textTertiary">
                      Roster player
                    </ThemedText>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <Card variant="default" style={styles.emptyCard}>
              <ThemedText variant="body" color="textTertiary" style={styles.emptyText}>
                No players added yet
              </ThemedText>
              {canManageRoster && (
                <Button
                  title={t('teams.addPlayer')}
                  onPress={() => router.push(`/teams/${id}/players`)}
                  variant="outline"
                  size="small"
                  style={styles.emptyButton}
                />
              )}
            </Card>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { height: 200, justifyContent: 'space-between' },
  heroNav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.sm,
  },
  heroBackButton: { padding: spacing.sm },
  heroActions: { flexDirection: 'row', gap: spacing.md },
  heroIconButton: { padding: spacing.xs },
  heroContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  heroTeamName: { color: '#FFFFFF', fontSize: 28 },
  heroCoach: { color: 'rgba(255,255,255,0.8)', marginTop: spacing.xxs },
  scrollContent: { paddingTop: spacing.lg },
  statsQuickRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  quickStatCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
  },
  statsButton: { marginBottom: spacing.md },
  card: { marginBottom: spacing.md },
  infoRow: { flexDirection: 'row', gap: spacing.md },
  infoContent: { flex: 1 },
  section: { marginTop: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  addButton: { marginBottom: spacing.md },
  rosterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  rosterCard: {
    width: '48%',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: borderRadius.md,
    gap: spacing.xxs,
  },
  jerseyBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyCard: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { marginBottom: spacing.md, textAlign: 'center' },
  emptyButton: { marginTop: spacing.sm },
});
