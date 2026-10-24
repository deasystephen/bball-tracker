/**
 * Player stats profile - individual player statistics across teams and seasons
 */

import React from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AxiosError } from 'axios';
import {
  ThemedView,
  ThemedText,
  Card,
  LoadingSpinner,
  ErrorState,
  EmptyState,
} from '../../../components';
import { useAuthStore } from '../../../store/auth-store';
import { SeasonAverages, PlayerStatsCard } from '../../../components/stats';
import { PrintButton } from '../../../components/PrintButton';
import { usePlayerOverallStats } from '../../../hooks/useStats';
import { useTheme } from '../../../hooks/useTheme';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding, isWeb } from '../../../utils/responsive';
import { useGoBack } from '../../../hooks/useGoBack';
import { displayName } from '../../../utils/display-name';
import { BackButton } from '../../../components/BackButton';
import { useTranslation } from '../../../i18n';

export default function PlayerStatsScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/home');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const currentUserId = useAuthStore((s) => s.user?.id);

  const { data, isLoading, error, refetch } = usePlayerOverallStats(id);

  if (isLoading) {
    return <LoadingSpinner message={t('stats.loadingPlayerStats')} fullScreen />;
  }

  // The backend 404s when the player has no team memberships yet. For the
  // user's own "My Stats" that is a normal state, not an error.
  if (error instanceof AxiosError && error.response?.status === 404) {
    const isSelf = id === currentUserId;
    return (
      <ThemedView variant="background" style={styles.container}>
        <EmptyState
          icon="stats-chart-outline"
          title={isSelf ? t('stats.noStatsSelfTitle') : t('stats.noStatsPlayerTitle')}
          message={isSelf ? t('stats.noStatsSelfMessage') : t('stats.noStatsPlayerMessage')}
          actionLabel={isSelf ? t('stats.viewTeams') : t('common.goBack')}
          onAction={() => (isSelf ? router.push('/teams') : goBack())}
        />
      </ThemedView>
    );
  }

  if (error || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('stats.loadFailed')}
        onRetry={refetch}
        // The error replaces the whole screen, header included (#589).
        onBack={goBack}
      />
    );
  }

  const { player, teams, careerTotals } = data;

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header */}
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
        data-hide-on-print="true"
      >
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading numberOfLines={1}>
            {t('stats.playerStatsTitle')}
          </ThemedText>
        </View>
        {isWeb && <PrintButton />}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Player Hero Header */}
        <View style={[styles.playerHero, { backgroundColor: colors.primary }]}>
          <View style={styles.avatarRing}>
            <View style={styles.avatar}>
              <ThemedText variant="h1" heading={false} /* avatar initial */ style={styles.avatarText}>
                {displayName(player).charAt(0).toUpperCase()}
              </ThemedText>
            </View>
          </View>
          <ThemedText variant="h2" heading style={styles.playerName}>
            {displayName(player)}
          </ThemedText>
          <View style={styles.heroChips}>
            <View style={styles.heroChip}>
              <Ionicons name="people-outline" size={12} color="rgba(255,255,255,0.9)" />
              <ThemedText variant="caption" style={styles.heroChipText}>
                {t('seasons.teamCount', { count: teams.length })}
              </ThemedText>
            </View>
            <View style={styles.heroChip}>
              <Ionicons name="basketball-outline" size={12} color="rgba(255,255,255,0.9)" />
              <ThemedText variant="caption" style={styles.heroChipText}>
                {t('stats.gameCount', { count: careerTotals.gamesPlayed })}
              </ThemedText>
            </View>
          </View>
        </View>

        {/* Career Totals */}
        {careerTotals.gamesPlayed > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" heading style={styles.sectionTitle}>
              {t('stats.careerAverages')}
            </ThemedText>
            <SeasonAverages stats={careerTotals} />

            {/* Career Totals Card */}
            <Card variant="default" style={styles.careerCard}>
              <ThemedText variant="bodyBold" style={styles.cardTitle}>
                {t('stats.careerTotals')}
              </ThemedText>
              <View style={styles.totalsRow}>
                <View style={styles.totalItem}>
                  <ThemedText variant="h3">{careerTotals.points}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">{t('stats.points')}</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="h3">{careerTotals.rebounds}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">{t('stats.rebounds')}</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="h3">{careerTotals.assists}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">{t('stats.assists')}</ThemedText>
                </View>
              </View>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <View style={styles.totalsRow}>
                <View style={styles.totalItem}>
                  <ThemedText variant="body">{careerTotals.steals}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">{t('stats.steals')}</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="body">{careerTotals.blocks}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">{t('stats.blocks')}</ThemedText>
                </View>
                <View style={styles.totalItem}>
                  <ThemedText variant="body">{careerTotals.efficiency.toFixed(1)}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">{t('stats.efficiency')}</ThemedText>
                </View>
              </View>
            </Card>

            {/* Shooting Stats */}
            <Card variant="default" style={styles.shootingCard}>
              <ThemedText variant="bodyBold" style={styles.cardTitle}>
                {t('stats.shooting')}
              </ThemedText>
              <View style={styles.shootingRow}>
                <View style={styles.shootingItem}>
                  <ThemedText variant="h3">
                    {careerTotals.fieldGoalPercentage.toFixed(1)}%
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {t('stats.shootingMadeAttempted', { label: t('stats.abbr.fg'), made: careerTotals.fieldGoalsMade, attempted: careerTotals.fieldGoalsAttempted })}
                  </ThemedText>
                </View>
                <View style={styles.shootingItem}>
                  <ThemedText variant="h3">
                    {careerTotals.threePointPercentage.toFixed(1)}%
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {t('stats.shootingMadeAttempted', { label: t('stats.abbr.threes'), made: careerTotals.threePointersMade, attempted: careerTotals.threePointersAttempted })}
                  </ThemedText>
                </View>
                <View style={styles.shootingItem}>
                  <ThemedText variant="h3">
                    {careerTotals.freeThrowPercentage.toFixed(1)}%
                  </ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {t('stats.shootingMadeAttempted', { label: t('stats.abbr.ft'), made: careerTotals.freeThrowsMade, attempted: careerTotals.freeThrowsAttempted })}
                  </ThemedText>
                </View>
              </View>
            </Card>
          </View>
        )}

        {/* Stats by Team */}
        {teams.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" heading style={styles.sectionTitle}>
              {t('stats.statsByTeam')}
            </ThemedText>
            {teams.map((teamData) => (
              <View key={teamData.teamId} style={styles.teamSection}>
                <TouchableOpacity
                  style={styles.teamHeader}
                  onPress={() => router.push(`/teams/${teamData.teamId}/stats`)}
                  accessibilityRole="button"
                >
                  <View>
                    <ThemedText variant="bodyBold">{teamData.teamName}</ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      {teamData.seasonName}
                    </ThemedText>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color={colors.textTertiary}
                  />
                </TouchableOpacity>
                <PlayerStatsCard
                  stats={teamData.stats}
                  showAverages={true}
                  compact={false}
                />
              </View>
            ))}
          </View>
        )}

        {/* Empty State */}
        {careerTotals.gamesPlayed === 0 && (
          <Card variant="default" style={styles.emptyCard}>
            <Ionicons name="stats-chart-outline" size={48} color={colors.textTertiary} />
            <ThemedText variant="body" color="textSecondary" style={styles.emptyText}>
              {t('stats.noStatsAvailable')}
            </ThemedText>
          </Card>
        )}
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
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  playerHero: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.lg,
  },
  avatarRing: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  playerName: {
    color: '#FFFFFF',
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  heroChips: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  heroChipText: {
    color: 'rgba(255,255,255,0.9)',
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    marginBottom: spacing.md,
  },
  careerCard: {
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTitle: {
    marginBottom: spacing.md,
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  totalItem: {
    alignItems: 'center',
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.md,
  },
  shootingCard: {
    padding: spacing.lg,
  },
  shootingRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: spacing.sm,
  },
  shootingItem: {
    alignItems: 'center',
    flex: 1,
  },
  teamSection: {
    marginBottom: spacing.md,
  },
  teamHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    paddingVertical: spacing.xs,
  },
  emptyCard: {
    alignItems: 'center',
    padding: spacing.xl,
    marginTop: spacing.xl,
  },
  emptyText: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
