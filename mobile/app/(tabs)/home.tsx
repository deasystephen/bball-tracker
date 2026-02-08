/**
 * Home screen - main dashboard for authenticated users
 */

import React from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../store/auth-store';
import { useTeams } from '../../hooks/useTeams';
import { useGames } from '../../hooks/useGames';
import { useInvitations } from '../../hooks/useInvitations';
import { useTheme } from '../../hooks/useTheme';
import {
  ThemedView,
  ThemedText,
  Card,
  LoadingSpinner,
  ErrorState,
} from '../../components';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { getTeamColor } from '../../utils/team-colors';
import type { Game } from '../../types/game';

export default function Home() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const {
    data: teams,
    isLoading: teamsLoading,
    refetch: refetchTeams,
    isRefetching: teamsRefetching,
  } = useTeams();

  const {
    data: games,
    refetch: refetchGames,
    isRefetching: gamesRefetching,
  } = useGames();

  const {
    data: invitationsData,
    isLoading: invitationsLoading,
    refetch: refetchInvitations,
    isRefetching: invitationsRefetching,
  } = useInvitations({ status: 'PENDING' });

  const pendingInvitations = invitationsData?.invitations || [];
  const isLoading = teamsLoading || invitationsLoading;
  const isRefetching = teamsRefetching || invitationsRefetching || gamesRefetching;

  const handleRefresh = () => {
    refetchTeams();
    refetchInvitations();
    refetchGames();
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const liveGame = games?.find((g: Game) => g.status === 'IN_PROGRESS');
  const recentGames =
    games?.filter((g: Game) => g.status === 'FINISHED').slice(0, 5) || [];

  if (isLoading) {
    return <LoadingSpinner fullScreen message="Loading dashboard..." />;
  }

  if (
    !teamsLoading &&
    !invitationsLoading &&
    (teams === undefined || invitationsData === undefined)
  ) {
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
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingHorizontal: padding,
            paddingTop: insets.top + spacing.sm,
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Compact Greeting Bar */}
        <View style={styles.greetingBar}>
          <View style={styles.greetingLeft}>
            <ThemedText variant="caption" color="textSecondary">
              {getGreeting()}
            </ThemedText>
            <ThemedText variant="h3">
              {user?.name?.split(' ')[0] || 'Coach'}
            </ThemedText>
          </View>
          <View style={styles.greetingRight}>
            {pendingInvitations.length > 0 && (
              <TouchableOpacity
                onPress={() => router.push('/invitations')}
                style={styles.bellButton}
                accessibilityLabel={`${pendingInvitations.length} pending invitations`}
              >
                <Ionicons name="notifications" size={22} color={colors.text} />
                <View
                  style={[styles.bellBadge, { backgroundColor: colors.error }]}
                >
                  <ThemedText variant="footnote" style={styles.bellBadgeText}>
                    {pendingInvitations.length}
                  </ThemedText>
                </View>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => router.push('/profile')}
              style={[styles.avatarSmall, { backgroundColor: colors.primary }]}
            >
              <ThemedText variant="captionBold" style={styles.avatarSmallText}>
                {user?.name?.charAt(0)?.toUpperCase() || '?'}
              </ThemedText>
            </TouchableOpacity>
          </View>
        </View>

        {/* Live Game Hero Card */}
        {liveGame && (
          <TouchableOpacity
            onPress={() => router.push(`/games/${liveGame.id}`)}
            activeOpacity={0.85}
            style={styles.liveCardWrapper}
          >
            <View
              style={[
                styles.liveCard,
                { backgroundColor: colors.primaryDark },
              ]}
            >
              <View style={styles.liveIndicator}>
                <View
                  style={[styles.liveDot, { backgroundColor: colors.live }]}
                />
                <ThemedText
                  variant="captionBold"
                  style={{ color: colors.live }}
                >
                  LIVE
                </ThemedText>
              </View>
              <View style={styles.liveScoreRow}>
                <View style={styles.liveTeam}>
                  <ThemedText
                    variant="caption"
                    style={styles.liveTeamName}
                    numberOfLines={1}
                  >
                    {liveGame.team?.name || 'Home'}
                  </ThemedText>
                  <ThemedText variant="h1" style={styles.liveScore}>
                    {liveGame.homeScore}
                  </ThemedText>
                </View>
                <ThemedText variant="h3" style={styles.liveDash}>
                  -
                </ThemedText>
                <View style={styles.liveTeam}>
                  <ThemedText
                    variant="caption"
                    style={styles.liveTeamName}
                    numberOfLines={1}
                  >
                    {liveGame.opponent}
                  </ThemedText>
                  <ThemedText variant="h1" style={styles.liveScore}>
                    {liveGame.awayScore}
                  </ThemedText>
                </View>
              </View>
              <View
                style={[styles.liveCTA, { backgroundColor: colors.accent }]}
              >
                <ThemedText variant="captionBold" style={styles.liveCTAText}>
                  Continue Tracking
                </ThemedText>
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* Quick Stats Strip */}
        <View style={styles.quickStats}>
          <View
            style={[
              styles.statBubble,
              { backgroundColor: colors.backgroundSecondary },
            ]}
          >
            <ThemedText variant="h3" color="success">
              {recentGames.filter((g: Game) => g.homeScore > g.awayScore).length}
            </ThemedText>
            <ThemedText variant="footnote" color="textSecondary">
              Wins
            </ThemedText>
          </View>
          <View
            style={[
              styles.statBubble,
              { backgroundColor: colors.backgroundSecondary },
            ]}
          >
            <ThemedText variant="h3" color="primary">
              {teams?.length || 0}
            </ThemedText>
            <ThemedText variant="footnote" color="textSecondary">
              Teams
            </ThemedText>
          </View>
          <View
            style={[
              styles.statBubble,
              { backgroundColor: colors.backgroundSecondary },
            ]}
          >
            <ThemedText variant="h3" color="textSecondary">
              {games?.filter((g: Game) => g.status === 'SCHEDULED').length || 0}
            </ThemedText>
            <ThemedText variant="footnote" color="textSecondary">
              Upcoming
            </ThemedText>
          </View>
        </View>

        {/* Teams Horizontal Scroll */}
        {teams && teams.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <ThemedText variant="h4">Your Teams</ThemedText>
              <TouchableOpacity onPress={() => router.push('/teams')}>
                <ThemedText variant="caption" color="primary">
                  See All
                </ThemedText>
              </TouchableOpacity>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.teamPillsRow}
            >
              {teams.map((team) => {
                const teamColor = getTeamColor(team.name);
                return (
                  <TouchableOpacity
                    key={team.id}
                    style={[
                      styles.teamPill,
                      { backgroundColor: colors.backgroundSecondary },
                    ]}
                    onPress={() => router.push(`/teams/${team.id}`)}
                  >
                    <View
                      style={[
                        styles.teamPillIcon,
                        { backgroundColor: teamColor + '20' },
                      ]}
                    >
                      <ThemedText
                        variant="captionBold"
                        style={{ color: teamColor }}
                      >
                        {team.name.charAt(0).toUpperCase()}
                      </ThemedText>
                    </View>
                    <ThemedText
                      variant="captionBold"
                      numberOfLines={1}
                      style={styles.teamPillName}
                    >
                      {team.name}
                    </ThemedText>
                    <ThemedText variant="footnote" color="textSecondary">
                      {team._count?.members ?? team.members?.length ?? 0} players
                    </ThemedText>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* Recent Activity Feed */}
        <View style={styles.section}>
          <ThemedText variant="h4" style={styles.sectionTitle}>
            Recent Activity
          </ThemedText>

          {recentGames.length === 0 && pendingInvitations.length === 0 && (
            <Card variant="default" style={styles.emptyCard}>
              <View style={styles.emptyContent}>
                <Ionicons
                  name="basketball-outline"
                  size={40}
                  color={colors.textTertiary}
                />
                <ThemedText
                  variant="body"
                  color="textSecondary"
                  style={styles.emptyText}
                >
                  No recent activity yet
                </ThemedText>
              </View>
            </Card>
          )}

          {pendingInvitations.slice(0, 3).map((invitation) => (
            <TouchableOpacity
              key={`inv-${invitation.id}`}
              onPress={() => router.push('/invitations')}
              style={styles.activityItem}
            >
              <View
                style={[
                  styles.activityStripe,
                  { backgroundColor: colors.warning },
                ]}
              />
              <View
                style={[
                  styles.activityIcon,
                  { backgroundColor: colors.warning + '20' },
                ]}
              >
                <Ionicons name="mail-unread" size={18} color={colors.warning} />
              </View>
              <View style={styles.activityInfo}>
                <ThemedText variant="bodyBold" numberOfLines={1}>
                  {invitation.team.name}
                </ThemedText>
                <ThemedText variant="footnote" color="textSecondary">
                  Invitation from {invitation.invitedBy.name}
                </ThemedText>
              </View>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={colors.textTertiary}
              />
            </TouchableOpacity>
          ))}

          {recentGames.map((game: Game) => {
            const isWin = game.homeScore > game.awayScore;
            return (
              <TouchableOpacity
                key={`game-${game.id}`}
                onPress={() => router.push(`/games/${game.id}`)}
                style={styles.activityItem}
              >
                <View
                  style={[
                    styles.activityStripe,
                    {
                      backgroundColor: isWin ? colors.success : colors.error,
                    },
                  ]}
                />
                <View
                  style={[
                    styles.activityIcon,
                    {
                      backgroundColor: isWin
                        ? colors.success + '20'
                        : colors.error + '20',
                    },
                  ]}
                >
                  <ThemedText
                    variant="captionBold"
                    style={{ color: isWin ? colors.success : colors.error }}
                  >
                    {isWin ? 'W' : 'L'}
                  </ThemedText>
                </View>
                <View style={styles.activityInfo}>
                  <ThemedText variant="bodyBold" numberOfLines={1}>
                    vs {game.opponent}
                  </ThemedText>
                  <ThemedText variant="footnote" color="textSecondary">
                    {game.homeScore} - {game.awayScore}
                  </ThemedText>
                </View>
                <ThemedText variant="footnote" color="textTertiary">
                  {new Date(game.date).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </ThemedText>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* No teams empty state */}
        {(!teams || teams.length === 0) && (
          <View style={styles.section}>
            <Card variant="elevated" style={styles.emptyCard}>
              <View style={styles.emptyContent}>
                <Ionicons
                  name="people-outline"
                  size={40}
                  color={colors.textTertiary}
                />
                <ThemedText
                  variant="body"
                  color="textSecondary"
                  style={styles.emptyText}
                >
                  No teams yet
                </ThemedText>
                <TouchableOpacity
                  style={[
                    styles.createButton,
                    { backgroundColor: colors.primary },
                  ]}
                  onPress={() => router.push('/teams/create')}
                >
                  <ThemedText
                    variant="captionBold"
                    style={{ color: colors.textInverse }}
                  >
                    Create Team
                  </ThemedText>
                </TouchableOpacity>
              </View>
            </Card>
          </View>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingBottom: spacing.xxl * 2 },
  greetingBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 48,
    marginBottom: spacing.md,
  },
  greetingLeft: { flex: 1 },
  greetingRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bellButton: { position: 'relative', padding: spacing.xs },
  bellBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  bellBadgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '700' },
  avatarSmall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarSmallText: { color: '#FFFFFF', fontWeight: '700' },
  liveCardWrapper: { marginBottom: spacing.md },
  liveCard: {
    height: 180,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  liveIndicator: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveScoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  liveTeam: { alignItems: 'center', flex: 1 },
  liveTeamName: { color: 'rgba(255,255,255,0.7)', marginBottom: spacing.xs },
  liveScore: { color: '#FFFFFF', fontSize: 42, lineHeight: 48 },
  liveDash: { color: 'rgba(255,255,255,0.5)' },
  liveCTA: {
    alignSelf: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
  },
  liveCTAText: { color: '#FFFFFF' },
  quickStats: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  statBubble: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
  },
  section: { marginBottom: spacing.lg },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  sectionTitle: { marginBottom: spacing.md },
  teamPillsRow: { gap: spacing.sm, paddingRight: spacing.md },
  teamPill: {
    width: 110,
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: borderRadius.md,
    gap: spacing.xs,
  },
  teamPillIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamPillName: { textAlign: 'center', maxWidth: 90 },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: borderRadius.sm,
  },
  activityStripe: { width: 3, height: 36, borderRadius: 2 },
  activityIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityInfo: { flex: 1 },
  emptyCard: { padding: spacing.xl },
  emptyContent: { alignItems: 'center', gap: spacing.md },
  emptyText: { textAlign: 'center' },
  createButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.sm,
    marginTop: spacing.sm,
  },
});
