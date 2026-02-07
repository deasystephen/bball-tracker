/**
 * Achievement badges grid component
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme/spacing';
import { typography } from '../theme/typography';

interface BadgeDefinition {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const BADGES: BadgeDefinition[] = [
  { id: 'first-game', label: 'First Game', icon: 'basketball' },
  { id: 'sharp-shooter', label: 'Sharp Shooter', icon: 'locate' },
  { id: 'double-double', label: 'Double-Double', icon: 'star' },
  { id: 'triple-double', label: 'Triple-Double', icon: 'trophy' },
  { id: 'win-streak', label: 'Win Streak', icon: 'flame' },
];

interface BadgeProps {
  badge: BadgeDefinition;
  earned: boolean;
}

const Badge: React.FC<BadgeProps> = ({ badge, earned }) => {
  const { colors } = useTheme();

  return (
    <View style={styles.badge}>
      <View
        style={[
          styles.badgeCircle,
          {
            backgroundColor: earned ? colors.accent + '20' : colors.backgroundTertiary,
            borderColor: earned ? colors.accent : colors.border,
          },
        ]}
      >
        <Ionicons
          name={badge.icon}
          size={28}
          color={earned ? colors.accent : colors.textTertiary}
        />
      </View>
      <Text
        style={[
          styles.badgeLabel,
          {
            color: earned ? colors.text : colors.textTertiary,
          },
        ]}
        numberOfLines={2}
      >
        {badge.label}
      </Text>
    </View>
  );
};

interface BadgeGridProps {
  earnedBadges: string[];
}

export const BadgeGrid: React.FC<BadgeGridProps> = ({ earnedBadges }) => {
  return (
    <View style={styles.grid}>
      {BADGES.map((badge) => (
        <Badge
          key={badge.id}
          badge={badge}
          earned={earnedBadges.includes(badge.id)}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: spacing.md,
  },
  badge: {
    alignItems: 'center',
    width: 90,
  },
  badgeCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  badgeLabel: {
    ...typography.footnote,
    textAlign: 'center',
  },
});
