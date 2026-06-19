/**
 * UsageMeter — a labeled progress bar showing "<count> of <limit> used" for a
 * single metered feature, with an upgrade CTA when the tier limit is reached.
 *
 * An unlimited allowance (`limit === null`) renders as "Unlimited" with no bar.
 * Used on the Profile screen to make upgrade CTAs land (e.g. "2 of 3 teams
 * used — upgrade for unlimited").
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing, borderRadius } from '../theme';
import type { UsageMetric } from '../hooks/useUsage';

interface UsageMeterProps {
  /** Feature label, e.g. "Teams". */
  label: string;
  metric: UsageMetric;
  /** Optional CTA text shown when the limit is reached, e.g. "Upgrade for unlimited". */
  upgradeHint?: string;
}

export function UsageMeter({ label, metric, upgradeHint }: UsageMeterProps): React.JSX.Element {
  const { colors } = useTheme();

  const limit = metric.limit;
  const unlimited = limit === null;
  const ratio = limit === null || limit === 0 ? 0 : Math.min(metric.count / limit, 1);
  const barColor = metric.limitReached ? colors.error : colors.primary;

  return (
    <View style={styles.container} accessibilityRole="progressbar">
      <View style={styles.labelRow}>
        <ThemedText variant="body">{label}</ThemedText>
        <ThemedText variant="bodyBold" color={metric.limitReached ? 'error' : 'text'}>
          {unlimited ? `${metric.count} · Unlimited` : `${metric.count} of ${metric.limit}`}
        </ThemedText>
      </View>

      {!unlimited && (
        <View style={[styles.track, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.fill,
              { width: `${ratio * 100}%`, backgroundColor: barColor },
            ]}
          />
        </View>
      )}

      {metric.limitReached && upgradeHint && (
        <ThemedText variant="caption" style={[styles.hint, { color: colors.accent }]}>
          {upgradeHint}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: spacing.sm, gap: spacing.xs },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  track: {
    height: 8,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: borderRadius.full,
  },
  hint: { marginTop: spacing.xxs },
});
