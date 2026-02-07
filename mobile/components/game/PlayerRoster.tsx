/**
 * Wrapping player selector grid for stat tracking
 */

import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { ThemedText } from '../ThemedText';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';

interface Player {
  id: string;
  playerId: string;
  jerseyNumber?: number;
  position?: string;
  player: {
    id: string;
    name: string;
  };
}

interface PlayerRosterProps {
  players: Player[];
  selectedPlayerId: string | null;
  onSelectPlayer: (playerId: string, playerName: string) => void;
}

const getInitials = (name: string): string => {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

/**
 * Memoized to prevent unnecessary re-renders when parent re-renders
 * (e.g., during score updates on the tracking screen).
 */
export const PlayerRoster: React.FC<PlayerRosterProps> = React.memo(({
  players,
  selectedPlayerId,
  onSelectPlayer,
}) => {
  const { colors } = useTheme();

  if (players.length === 0) {
    return (
      <View
        style={[
          styles.emptyContainer,
          { backgroundColor: colors.backgroundSecondary },
        ]}
      >
        <ThemedText variant="caption" color="textTertiary">
          No players on roster
        </ThemedText>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ThemedText
        variant="captionBold"
        color="textSecondary"
        style={styles.label}
      >
        Select Player
      </ThemedText>
      <View style={styles.grid}>
        {players.map((member) => {
          const isSelected = selectedPlayerId === member.playerId;
          return (
            <TouchableOpacity
              key={member.id}
              onPress={() =>
                onSelectPlayer(member.playerId, member.player.name)
              }
              style={[
                styles.playerChip,
                {
                  backgroundColor: isSelected
                    ? colors.primary
                    : colors.backgroundSecondary,
                  borderColor: isSelected ? colors.primary : colors.border,
                },
              ]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${member.player.name}${member.jerseyNumber ? `, number ${member.jerseyNumber}` : ''}`}
              accessibilityState={{ selected: isSelected }}
            >
              <View
                style={[
                  styles.avatar,
                  {
                    backgroundColor: isSelected
                      ? 'rgba(255,255,255,0.2)'
                      : colors.primary + '20',
                  },
                ]}
              >
                <ThemedText
                  variant="caption"
                  style={[
                    styles.initials,
                    { color: isSelected ? '#FFFFFF' : colors.primary },
                  ]}
                >
                  {member.jerseyNumber
                    ? `#${member.jerseyNumber}`
                    : getInitials(member.player.name)}
                </ThemedText>
              </View>
              <ThemedText
                variant="caption"
                numberOfLines={1}
                style={[
                  styles.playerName,
                  { color: isSelected ? '#FFFFFF' : colors.text },
                ]}
              >
                {member.player.name.split(' ')[0]}
              </ThemedText>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  label: {
    marginBottom: spacing.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  playerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    borderWidth: 1,
    gap: spacing.xs,
    minHeight: 44,
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  initials: {
    fontWeight: '700',
    fontSize: 10,
  },
  playerName: {
    fontWeight: '600',
    fontSize: 12,
  },
  emptyContainer: {
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
  },
});
