/**
 * Live score display header for game tracking
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';

interface ScoreDisplayProps {
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  onBack?: () => void;
  onEndGame?: () => void;
  showEndButton?: boolean;
}

export const ScoreDisplay: React.FC<ScoreDisplayProps> = ({
  homeTeamName,
  awayTeamName,
  homeScore,
  awayScore,
  onBack,
  onEndGame,
  showEndButton = true,
}) => {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.card }]}>
      <View style={styles.topRow}>
        {onBack && (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
        )}
        <View style={styles.titleContainer}>
          <View style={[styles.liveBadge, { backgroundColor: colors.success }]}>
            <View style={styles.liveDot} />
            <ThemedText variant="caption" style={styles.liveText}>
              LIVE
            </ThemedText>
          </View>
        </View>
        {showEndButton && onEndGame ? (
          <TouchableOpacity
            onPress={onEndGame}
            style={[styles.endButton, { backgroundColor: colors.error + '20' }]}
            accessibilityRole="button"
            accessibilityLabel="End game"
          >
            <ThemedText
              variant="captionBold"
              style={{ color: colors.error }}
            >
              End
            </ThemedText>
          </TouchableOpacity>
        ) : (
          <View style={styles.placeholder} />
        )}
      </View>

      <View
        style={styles.scoreRow}
        accessibilityLabel={`Score: ${homeTeamName} ${homeScore}, ${awayTeamName} ${awayScore}`}
      >
        <View style={styles.teamScore}>
          <ThemedText
            variant="caption"
            color="textSecondary"
            numberOfLines={1}
            style={styles.teamName}
          >
            {homeTeamName}
          </ThemedText>
          <ThemedText variant="h1" style={styles.score}>
            {homeScore}
          </ThemedText>
        </View>

        <View style={styles.divider}>
          <ThemedText variant="h3" color="textTertiary">
            -
          </ThemedText>
        </View>

        <View style={[styles.teamScore, styles.awayTeam]}>
          <ThemedText
            variant="caption"
            color="textSecondary"
            numberOfLines={1}
            style={styles.teamName}
          >
            {awayTeamName}
          </ThemedText>
          <ThemedText variant="h1" style={styles.score}>
            {awayScore}
          </ThemedText>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  backButton: {
    padding: spacing.sm,
    marginLeft: -spacing.xs,
  },
  titleContainer: {
    alignItems: 'center',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    gap: spacing.xs,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  liveText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  endButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
  },
  placeholder: {
    width: 50,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamScore: {
    flex: 1,
    alignItems: 'center',
  },
  awayTeam: {
    alignItems: 'center',
  },
  teamName: {
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  score: {
    fontSize: 48,
    fontWeight: '700',
    lineHeight: 56,
  },
  divider: {
    paddingHorizontal: spacing.lg,
  },
});
