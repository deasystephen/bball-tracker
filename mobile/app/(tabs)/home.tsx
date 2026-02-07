/**
 * Home screen - main dashboard for authenticated users
 */

import React from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../store/auth-store';
import { useTeams } from '../../hooks/useTeams';
import { useInvitations } from '../../hooks/useInvitations';
import { useTheme } from '../../hooks/useTheme';
import { ThemedView, ThemedText, Card, LoadingSpinner, ErrorState } from '../../components';
import { spacing } from '../../theme';
import { getHorizontalPadding, getResponsiveValue } from '../../utils/responsive';

export default function Home() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();

  const {
    data: teams,
    isLoading: teamsLoading,
    refetch: refetchTeams,
    isRefetching: teamsRefetching,
  } = useTeams();

  const {
    data: invitationsData,
    isLoading: invitationsLoading,
    refetch: refetchInvitations,
    isRefetching: invitationsRefetching,
  } = useInvitations({ status: 'PENDING' });

  const pendingInvitations = invitationsData?.invitations || [];
  const isLoading = teamsLoading || invitationsLoading;
  const isRefetching = teamsRefetching || invitationsRefetching;

  const handleRefresh = () => {
    refetchTeams();
    refetchInvitations();
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  if (isLoading) {
    return <LoadingSpinner fullScreen message="Loading dashboard..." />;
  }

  if (!teamsLoading && !invitationsLoading && (teams === undefined || invitationsData === undefined)) {
    return (
      <ErrorState
        title="Something went wrong"
        message="We couldn't load your dashboard. Please check your connection and try again."
        onRetry={handleRefresh}
      />
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingHorizontal: padding }]}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Welcome Header */}
        <View style={styles.header}>
          <ThemedText variant="h2" style={styles.greeting}>
            {getGreeting()},
          </ThemedText>
          <ThemedText variant="h1" style={styles.userName}>
            {user?.name?.split(' ')[0] || 'Coach'}!
          </ThemedText>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <ThemedText variant="h4" style={styles.sectionTitle}>
            Quick Actions
          </ThemedText>
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: colors.primary }]}
              onPress={() => router.push('/teams')}
              accessibilityRole="button"
              accessibilityLabel="View Teams"
            >
              <Ionicons name="people" size={24} color={colors.textInverse} />
              <ThemedText variant="body" style={[styles.actionText, { color: colors.textInverse }]}>
                View Teams
              </ThemedText>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border, borderWidth: 1 }]}
              onPress={() => router.push('/invitations')}
              accessibilityRole="button"
              accessibilityLabel={pendingInvitations.length > 0 ? `Invitations, ${pendingInvitations.length} pending` : 'Invitations'}
            >
              <View style={styles.actionWithBadge}>
                <Ionicons name="mail" size={24} color={colors.primary} />
                {pendingInvitations.length > 0 && (
                  <View style={[styles.badge, { backgroundColor: colors.error }]}>
                    <ThemedText variant="caption" style={styles.badgeText}>
                      {pendingInvitations.length}
                    </ThemedText>
                  </View>
                )}
              </View>
              <ThemedText variant="body" style={styles.actionText}>
                Invitations
              </ThemedText>
            </TouchableOpacity>
          </View>
        </View>

        {/* Teams Summary */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <ThemedText variant="h4" style={styles.sectionTitle}>
              Your Teams
            </ThemedText>
            {teams && teams.length > 0 && (
              <TouchableOpacity onPress={() => router.push('/teams')}>
                <ThemedText variant="body" color="primary">
                  See All
                </ThemedText>
              </TouchableOpacity>
            )}
          </View>

          {!teams || teams.length === 0 ? (
            <Card variant="elevated" style={styles.emptyCard}>
              <View style={styles.emptyContent}>
                <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
                <ThemedText variant="body" color="textSecondary" style={styles.emptyText}>
                  No teams yet
                </ThemedText>
                <TouchableOpacity
                  style={[styles.createButton, { backgroundColor: colors.primary }]}
                  onPress={() => router.push('/teams/create')}
                >
                  <ThemedText variant="body" style={{ color: colors.textInverse }}>
                    Create Team
                  </ThemedText>
                </TouchableOpacity>
              </View>
            </Card>
          ) : (
            <View style={styles.teamsGrid}>
              {teams.slice(0, 4).map((team) => (
                <Card
                  key={team.id}
                  variant="elevated"
                  onPress={() => router.push(`/teams/${team.id}`)}
                  style={styles.teamCard}
                >
                  <View style={styles.teamCardContent}>
                    <View style={[styles.teamIcon, { backgroundColor: colors.primaryLight + '30' }]}>
                      <Ionicons name="basketball" size={24} color={colors.primary} />
                    </View>
                    <ThemedText variant="body" numberOfLines={1} style={styles.teamName}>
                      {team.name}
                    </ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      {team.members?.length || 0} players
                    </ThemedText>
                  </View>
                </Card>
              ))}
            </View>
          )}
        </View>

        {/* Pending Invitations */}
        {pendingInvitations.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <ThemedText variant="h4" style={styles.sectionTitle}>
                Pending Invitations
              </ThemedText>
              <TouchableOpacity onPress={() => router.push('/invitations')}>
                <ThemedText variant="body" color="primary">
                  View All
                </ThemedText>
              </TouchableOpacity>
            </View>

            {pendingInvitations.slice(0, 3).map((invitation) => (
              <Card
                key={invitation.id}
                variant="default"
                onPress={() => router.push('/invitations')}
                style={styles.invitationCard}
              >
                <View style={styles.invitationContent}>
                  <View style={[styles.invitationIcon, { backgroundColor: colors.warning + '20' }]}>
                    <Ionicons name="mail-unread" size={20} color={colors.warning} />
                  </View>
                  <View style={styles.invitationInfo}>
                    <ThemedText variant="body" numberOfLines={1}>
                      {invitation.team.name}
                    </ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      From {invitation.invitedBy.name}
                    </ThemedText>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                </View>
              </Card>
            ))}
          </View>
        )}

        {/* Role Badge */}
        <View style={styles.section}>
          <Card variant="default" style={styles.roleCard}>
            <View style={styles.roleContent}>
              <View style={[styles.roleIcon, { backgroundColor: colors.success + '20' }]}>
                <Ionicons
                  name={user?.role === 'COACH' ? 'clipboard' : 'person'}
                  size={24}
                  color={colors.success}
                />
              </View>
              <View style={styles.roleInfo}>
                <ThemedText variant="caption" color="textSecondary">
                  Signed in as
                </ThemedText>
                <ThemedText variant="h4">
                  {user?.role || 'Player'}
                </ThemedText>
              </View>
            </View>
          </Card>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  header: {
    marginBottom: spacing.xl,
  },
  greeting: {
    marginBottom: spacing.xs,
  },
  userName: {
    // User name styling
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    marginBottom: spacing.md,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  actionButton: {
    flex: 1,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    alignItems: 'center',
    gap: spacing.sm,
  },
  actionWithBadge: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -8,
    right: -8,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  actionText: {
    fontWeight: '600',
  },
  emptyCard: {
    padding: spacing.xl,
  },
  emptyContent: {
    alignItems: 'center',
    gap: spacing.md,
  },
  emptyText: {
    textAlign: 'center',
  },
  createButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 8,
    marginTop: spacing.sm,
  },
  teamsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  teamCard: {
    width: '47%',
    padding: spacing.md,
  },
  teamCardContent: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  teamIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  teamName: {
    fontWeight: '600',
    textAlign: 'center',
  },
  invitationCard: {
    marginBottom: spacing.sm,
  },
  invitationContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  invitationIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  invitationInfo: {
    flex: 1,
  },
  roleCard: {
    padding: spacing.md,
  },
  roleContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  roleIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  roleInfo: {
    flex: 1,
  },
});
