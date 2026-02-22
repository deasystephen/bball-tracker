import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme/spacing';
import { SubscriptionTier } from '../../shared/types';

interface UpgradePromptProps {
  requiredTier: SubscriptionTier;
  featureDescription?: string;
}

const TIER_LABELS: Record<SubscriptionTier, string> = {
  [SubscriptionTier.FREE]: 'Free',
  [SubscriptionTier.PREMIUM]: 'Premium',
  [SubscriptionTier.LEAGUE]: 'League',
};

export function UpgradePrompt({ requiredTier, featureDescription }: UpgradePromptProps) {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundTertiary, borderColor: colors.border }]}>
      <View style={styles.iconRow}>
        <Ionicons name="lock-closed" size={24} color={colors.accent} />
        <ThemedText style={styles.title}>
          {TIER_LABELS[requiredTier]} Feature
        </ThemedText>
      </View>
      {featureDescription && (
        <ThemedText style={[styles.description, { color: colors.textSecondary }]}>
          {featureDescription}
        </ThemedText>
      )}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.accent }]}
        activeOpacity={0.8}
      >
        <ThemedText style={[styles.buttonText, { color: colors.textInverse }]}>
          Upgrade to {TIER_LABELS[requiredTier]}
        </ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  description: {
    fontSize: 14,
    textAlign: 'center',
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 8,
    marginTop: spacing.xs,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
