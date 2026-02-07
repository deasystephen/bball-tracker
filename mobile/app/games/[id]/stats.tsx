/**
 * Full game box score screen with printable stats
 */

import React from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  LoadingSpinner,
  ErrorState,
} from '../../../components';
import { BoxScoreTable, PlayerStatsCard } from '../../../components/stats';
import { PrintButton } from '../../../components/PrintButton';
import { useBoxScore } from '../../../hooks/useStats';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding, isWeb } from '../../../utils/responsive';

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
};

interface ComparisonBarProps {
  label: string;
  homeValue: number;
  awayValue: number;
  colors: ReturnType<typeof useTheme>['colors'];
  isPercentage?: boolean;
}

const ComparisonBar: React.FC<ComparisonBarProps> = ({
  label,
  homeValue,
  awayValue,
  colors,
  isPercentage = false,
}) => {
  const total = homeValue + awayValue;
  const homePct = total > 0 ? homeValue / total : 0.5;
  const awayPct = total > 0 ? awayValue / total : 0.5;
  const displayHome = isPercentage ? `${homeValue.toFixed(1)}%` : String(homeValue);
  const displayAway = isPercentage ? `${awayValue.toFixed(1)}%` : String(awayValue);

  return (
    <View style={compStyles.row}>
      <ThemedText variant="captionBold" style={compStyles.value}>
        {displayHome}
      </ThemedText>
      <View style={compStyles.barContainer}>
        <View
          style={[
            compStyles.barLeft,
            {
              flex: homePct,
              backgroundColor: colors.primary,
            },
          ]}
        />
        <View style={compStyles.barGap} />
        <View
          style={[
            compStyles.barRight,
            {
              flex: awayPct,
              backgroundColor: colors.error,
            },
          ]}
        />
      </View>
      <ThemedText variant="captionBold" style={compStyles.value}>
        {displayAway}
      </ThemedText>
      <ThemedText
        variant="caption"
        color="textSecondary"
        style={compStyles.label}
      >
        {label}
      </ThemedText>
    </View>
  );
};

const compStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  value: {
    width: 44,
    textAlign: 'center',
  },
  barContainer: {
    flex: 1,
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  barLeft: {
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
  },
  barGap: {
    width: 2,
  },
  barRight: {
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  label: {
    width: 36,
    textAlign: 'center',
  },
});

export default function GameStatsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const { data: boxScore, isLoading, error, refetch } = useBoxScore(id);

  if (isLoading) {
    return <LoadingSpinner message="Loading box score..." fullScreen />;
  }

  if (error || !boxScore) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load stats'}
        onRetry={refetch}
      />
    );
  }

  const isWin = boxScore.game.homeScore > boxScore.game.awayScore;
  const resultText = isWin ? 'W' : 'L';
  const resultColor = isWin ? colors.success : colors.error;

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
        // @ts-ignore - web-specific attribute for print hiding
        data-hide-on-print="true"
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
          <ThemedText variant="h2" numberOfLines={1}>
            Box Score
          </ThemedText>
        </View>
        {isWeb && <PrintButton title="Print" />}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Game Header */}
        <Card variant="elevated" style={styles.gameHeader}>
          <View style={styles.matchupContainer}>
            <View style={styles.teamSection}>
              <ThemedText variant="h3" style={styles.teamName}>
                {boxScore.team.name}
              </ThemedText>
              <ThemedText
                variant="h1"
                style={[styles.finalScore, { color: isWin ? colors.success : colors.text }]}
              >
                {boxScore.game.homeScore}
              </ThemedText>
            </View>
            <View style={styles.vsContainer}>
              <ThemedText
                variant="h3"
                style={[styles.resultBadge, { color: resultColor }]}
              >
                {resultText}
              </ThemedText>
              <ThemedText variant="caption" color="textTertiary">
                FINAL
              </ThemedText>
            </View>
            <View style={[styles.teamSection, styles.awaySection]}>
              <ThemedText variant="h3" style={styles.teamName}>
                {boxScore.game.opponent}
              </ThemedText>
              <ThemedText
                variant="h1"
                style={[styles.finalScore, { color: !isWin ? colors.error : colors.text }]}
              >
                {boxScore.game.awayScore}
              </ThemedText>
            </View>
          </View>
          <ThemedText variant="caption" color="textSecondary" style={styles.gameDate}>
            {formatDate(boxScore.game.date)}
          </ThemedText>
        </Card>

        {/* Team Comparison Bars */}
        <View style={styles.section}>
          <ThemedText variant="h3" style={styles.sectionTitle}>
            Team Comparison
          </ThemedText>
          <Card variant="default" style={styles.comparisonCard}>
            <View style={styles.comparisonLegend}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
                <ThemedText variant="caption" color="textSecondary">
                  {boxScore.team.name}
                </ThemedText>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.error }]} />
                <ThemedText variant="caption" color="textSecondary">
                  {boxScore.game.opponent}
                </ThemedText>
              </View>
            </View>
            <ComparisonBar
              label="PTS"
              homeValue={boxScore.team.stats.points}
              awayValue={boxScore.game.awayScore}
              colors={colors}
            />
            <ComparisonBar
              label="REB"
              homeValue={boxScore.team.stats.rebounds}
              awayValue={0}
              colors={colors}
            />
            <ComparisonBar
              label="AST"
              homeValue={boxScore.team.stats.assists}
              awayValue={0}
              colors={colors}
            />
            <ComparisonBar
              label="FG%"
              homeValue={boxScore.team.stats.fieldGoalPercentage}
              awayValue={0}
              colors={colors}
              isPercentage
            />
            <ComparisonBar
              label="3P%"
              homeValue={boxScore.team.stats.threePointPercentage}
              awayValue={0}
              colors={colors}
              isPercentage
            />
          </Card>
        </View>

        {/* Team Stats Summary */}
        <View style={styles.section}>
          <ThemedText variant="h3" style={styles.sectionTitle}>
            Team Statistics
          </ThemedText>
          <Card variant="default" style={styles.teamStatsCard}>
            <View style={styles.teamStatsRow}>
              <View style={styles.teamStatItem}>
                <ThemedText variant="h2">{boxScore.team.stats.points}</ThemedText>
                <ThemedText variant="caption" color="textSecondary">Points</ThemedText>
              </View>
              <View style={styles.teamStatItem}>
                <ThemedText variant="h2">{boxScore.team.stats.rebounds}</ThemedText>
                <ThemedText variant="caption" color="textSecondary">Rebounds</ThemedText>
              </View>
              <View style={styles.teamStatItem}>
                <ThemedText variant="h2">{boxScore.team.stats.assists}</ThemedText>
                <ThemedText variant="caption" color="textSecondary">Assists</ThemedText>
              </View>
            </View>
            <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
            <View style={styles.teamStatsRow}>
              <View style={styles.teamStatItem}>
                <ThemedText variant="bodyBold">
                  {boxScore.team.stats.fieldGoalPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">FG%</ThemedText>
              </View>
              <View style={styles.teamStatItem}>
                <ThemedText variant="bodyBold">
                  {boxScore.team.stats.threePointPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">3P%</ThemedText>
              </View>
              <View style={styles.teamStatItem}>
                <ThemedText variant="bodyBold">
                  {boxScore.team.stats.freeThrowPercentage.toFixed(1)}%
                </ThemedText>
                <ThemedText variant="caption" color="textSecondary">FT%</ThemedText>
              </View>
            </View>
          </Card>
        </View>

        {/* Full Box Score Table */}
        <View style={styles.section}>
          <ThemedText variant="h3" style={styles.sectionTitle}>
            Player Statistics
          </ThemedText>
          {boxScore.team.players.length > 0 ? (
            <BoxScoreTable
              players={boxScore.team.players}
              teamStats={boxScore.team.stats}
              showExtendedStats={true}
            />
          ) : (
            <Card variant="default">
              <ThemedText variant="body" color="textSecondary">
                No player statistics recorded for this game.
              </ThemedText>
            </Card>
          )}
        </View>

        {/* Individual Player Cards (mobile-friendly view) */}
        {!isWeb && boxScore.team.players.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h3" style={styles.sectionTitle}>
              Individual Performance
            </ThemedText>
            {boxScore.team.players.map((player) => (
              <PlayerStatsCard
                key={player.playerId}
                stats={player}
                onPress={() => router.push(`/players/${player.playerId}/stats`)}
              />
            ))}
          </View>
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
    padding: spacing.sm,
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  gameHeader: {
    marginBottom: spacing.lg,
    alignItems: 'center',
  },
  matchupContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  teamSection: {
    flex: 1,
    alignItems: 'center',
  },
  awaySection: {
    alignItems: 'center',
  },
  teamName: {
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  finalScore: {
    fontSize: 48,
    fontWeight: '700',
    lineHeight: 56,
  },
  vsContainer: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  resultBadge: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  gameDate: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
  section: {
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    marginBottom: spacing.md,
  },
  comparisonCard: {
    padding: spacing.lg,
  },
  comparisonLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.lg,
    marginBottom: spacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  teamStatsCard: {
    padding: spacing.lg,
  },
  teamStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  teamStatItem: {
    alignItems: 'center',
    flex: 1,
  },
  statDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.md,
  },
});
