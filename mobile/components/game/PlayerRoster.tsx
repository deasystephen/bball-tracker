/**
 * Wrapping player selector grid for stat tracking
 */

import React, { useCallback } from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  withTiming,
  interpolateColor,
  useDerivedValue,
} from 'react-native-reanimated';
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
  hotPlayers?: Record<string, number>;
}

const getInitials = (name: string): string => {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PlayerChipProps {
  member: Player;
  isSelected: boolean;
  isHot: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  onPress: () => void;
}

const PlayerChip: React.FC<PlayerChipProps> = ({
  member,
  isSelected,
  isHot,
  colors,
  onPress,
}) => {
  const selectionProgress = useDerivedValue(() => {
    return withTiming(isSelected ? 1 : 0, { duration: 200 });
  }, [isSelected]);

  const animatedChipStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      selectionProgress.value,
      [0, 1],
      [colors.backgroundSecondary, colors.primary]
    );
    const borderColor = interpolateColor(
      selectionProgress.value,
      [0, 1],
      [colors.border, colors.primary]
    );
    return { backgroundColor, borderColor };
  });

  const handlePress = () => {
    Haptics.selectionAsync();
    onPress();
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      style={[styles.playerChip, animatedChipStyle]}
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
      {isHot && (
        <Ionicons name="flame" size={14} color="#FF6B35" />
      )}
    </AnimatedPressable>
  );
};

/**
 * Memoized to prevent unnecessary re-renders when parent re-renders
 * (e.g., during score updates on the tracking screen).
 */
export const PlayerRoster: React.FC<PlayerRosterProps> = React.memo(({
  players,
  selectedPlayerId,
  onSelectPlayer,
  hotPlayers = {},
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
          const isHot = (hotPlayers[member.playerId] || 0) >= 3;
          return (
            <PlayerChip
              key={member.id}
              member={member}
              isSelected={isSelected}
              isHot={isHot}
              colors={colors}
              onPress={() => onSelectPlayer(member.playerId, member.player.name)}
            />
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
