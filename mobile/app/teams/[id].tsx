/**
 * Team details screen
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
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../store/auth-store';

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

  // Get head coach(es) for display
  const headCoaches = team?.staff?.filter((s) => s.role.type === 'HEAD_COACH') ?? [];
  const otherStaff = team?.staff?.filter((s) => s.role.type !== 'HEAD_COACH') ?? [];

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
            } catch (error) {
              Alert.alert(
                'Error',
                error instanceof Error ? error.message : 'Failed to delete team'
              );
            }
          },
        },
      ]
    );
  };

  const handleEdit = () => {
    router.push(`/teams/${id}/edit`);
  };

  const handleManagePlayers = () => {
    router.push(`/teams/${id}/players`);
  };

  const handleViewStats = () => {
    router.push(`/teams/${id}/stats`);
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

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header with back button */}
      <View
        style={[
          styles.topHeader,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: padding,
            paddingBottom: spacing.md,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" numberOfLines={1} style={styles.headerTitle}>
            {team.name}
          </ThemedText>
        </View>
        {canManageTeam && (
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={handleEdit} style={styles.iconButton}>
              <Ionicons name="create-outline" size={24} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleDelete} style={styles.iconButton}>
              <Ionicons name="trash-outline" size={24} color={colors.error} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >

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

        {/* Team Stats Button */}
        <Button
          title="View Team Stats"
          onPress={handleViewStats}
          variant="outline"
          style={styles.statsButton}
        />

        {/* Head Coach Info */}
        {headCoaches.length > 0 && (
          <Card variant="elevated" style={styles.card}>
            <View style={styles.infoRow}>
              <Ionicons name="person-outline" size={20} color={colors.primary} />
              <View style={styles.infoContent}>
                <ThemedText variant="caption" color="textSecondary">
                  {headCoaches.length === 1 ? 'Head Coach' : 'Head Coaches'}
                </ThemedText>
                {headCoaches.map((coach) => (
                  <View key={coach.id} style={styles.staffMember}>
                    <ThemedText variant="bodyBold">{coach.user.name}</ThemedText>
                    <ThemedText variant="caption" color="textTertiary">
                      {coach.user.email}
                    </ThemedText>
                  </View>
                ))}
              </View>
            </View>
          </Card>
        )}

        {/* Other Staff */}
        {otherStaff.length > 0 && (
          <Card variant="elevated" style={styles.card}>
            <View style={styles.infoRow}>
              <Ionicons name="people-outline" size={20} color={colors.primary} />
              <View style={styles.infoContent}>
                <ThemedText variant="caption" color="textSecondary">
                  Staff
                </ThemedText>
                {otherStaff.map((staff) => (
                  <View key={staff.id} style={styles.staffMember}>
                    <ThemedText variant="bodyBold">{staff.user.name}</ThemedText>
                    <ThemedText variant="caption" color="textTertiary">
                      {staff.role.name}
                    </ThemedText>
                  </View>
                ))}
              </View>
            </View>
          </Card>
        )}

        {/* Players Section */}
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
              onPress={handleManagePlayers}
              variant="primary"
              style={styles.addButton}
            />
          )}

          {team.members && team.members.length > 0 ? (
            <Card variant="default" style={styles.playersCard}>
              {team.members.map((member) => (
                <ListItem
                  key={member.id}
                  title={member.player.name}
                  subtitle={
                    [
                      member.jerseyNumber && `#${member.jerseyNumber}`,
                      member.position,
                    ]
                      .filter(Boolean)
                      .join(' - ') || member.player.email
                  }
                  onPress={() => router.push(`/teams/${id}/players/${member.playerId}`)}
                  rightElement={
                    <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                  }
                />
              ))}
            </Card>
          ) : (
            <Card variant="default" style={styles.emptyCard}>
              <ThemedText variant="body" color="textTertiary" style={styles.emptyText}>
                No players added yet
              </ThemedText>
              {canManageRoster && (
                <Button
                  title={t('teams.addPlayer')}
                  onPress={handleManagePlayers}
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
  container: {
    flex: 1,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    padding: spacing.xs,
    marginRight: spacing.sm,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  headerActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  iconButton: {
    padding: spacing.xs,
  },
  card: {
    marginBottom: spacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  infoContent: {
    flex: 1,
  },
  staffMember: {
    marginTop: spacing.xs,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  addButton: {
    marginBottom: spacing.md,
  },
  playersCard: {
    marginTop: spacing.sm,
  },
  emptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: spacing.sm,
  },
  statsButton: {
    marginBottom: spacing.md,
  },
});
