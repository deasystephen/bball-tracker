/**
 * Recent events timeline for game tracking
 */

import React from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '../ThemedText';
import { ThemedView } from '../ThemedView';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import type { GameEvent, ShotMetadata, ReboundMetadata } from '../../types/game';

interface EventTimelineProps {
  events: GameEvent[];
  maxEvents?: number;
}

const formatTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
};

const getEventDescription = (event: GameEvent): string => {
  switch (event.eventType) {
    case 'SHOT': {
      const metadata = event.metadata as ShotMetadata;
      const points = metadata?.points || 2;
      const made = metadata?.made ?? false;
      return `${points}pt ${made ? 'made' : 'miss'}`;
    }
    case 'REBOUND': {
      const metadata = event.metadata as unknown as ReboundMetadata;
      const type = metadata?.type === 'offensive' ? 'Offensive' : 'Defensive';
      return `${type} rebound`;
    }
    case 'ASSIST':
      return 'Assist';
    case 'STEAL':
      return 'Steal';
    case 'BLOCK':
      return 'Block';
    case 'TURNOVER':
      return 'Turnover';
    case 'FOUL':
      return 'Foul';
    default:
      return event.eventType.toLowerCase();
  }
};

const getEventIcon = (
  event: GameEvent,
  colors: ReturnType<typeof useTheme>['colors']
): { name: keyof typeof Ionicons.glyphMap; color: string } => {
  switch (event.eventType) {
    case 'SHOT': {
      const metadata = event.metadata as ShotMetadata;
      const made = metadata?.made ?? false;
      return {
        name: made ? 'checkmark-circle' : 'close-circle',
        color: made ? colors.success : colors.error,
      };
    }
    case 'REBOUND': {
      const metadata = event.metadata as unknown as ReboundMetadata;
      return {
        name: metadata?.type === 'offensive' ? 'arrow-up-circle' : 'arrow-down-circle',
        color: metadata?.type === 'offensive' ? colors.success : colors.info,
      };
    }
    case 'ASSIST':
      return { name: 'people', color: colors.primary };
    case 'STEAL':
      return { name: 'hand-left', color: colors.warning };
    case 'BLOCK':
      return { name: 'stop-circle', color: colors.error };
    case 'TURNOVER':
      return { name: 'alert-circle', color: colors.error };
    case 'FOUL':
      return { name: 'warning', color: colors.warning };
    default:
      return { name: 'basketball', color: colors.primary };
  }
};

export const EventTimeline: React.FC<EventTimelineProps> = ({
  events,
  maxEvents = 10,
}) => {
  const { colors } = useTheme();
  const displayEvents = events.slice(0, maxEvents);

  if (displayEvents.length === 0) {
    return (
      <ThemedView variant="background" style={styles.emptyContainer}>
        <Ionicons
          name="time-outline"
          size={32}
          color={colors.textTertiary}
        />
        <ThemedText
          variant="body"
          color="textTertiary"
          style={styles.emptyText}
        >
          No events yet
        </ThemedText>
        <ThemedText variant="caption" color="textTertiary">
          Start tracking to see plays here
        </ThemedText>
      </ThemedView>
    );
  }

  const renderEvent = ({ item, index }: { item: GameEvent; index: number }) => {
    const icon = getEventIcon(item, colors);
    const isFirst = index === 0;

    return (
      <View
        style={[
          styles.eventRow,
          isFirst && styles.eventRowFirst,
          { borderLeftColor: colors.border },
        ]}
      >
        <View
          style={[
            styles.iconContainer,
            { backgroundColor: icon.color + '20' },
          ]}
        >
          <Ionicons name={icon.name} size={16} color={icon.color} />
        </View>
        <View style={styles.eventContent}>
          <View style={styles.eventHeader}>
            <ThemedText variant="bodyBold" numberOfLines={1}>
              {item.player?.name || 'Unknown Player'}
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary">
              {formatTime(item.timestamp || item.createdAt)}
            </ThemedText>
          </View>
          <ThemedText variant="caption" color="textSecondary">
            {getEventDescription(item)}
          </ThemedText>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <ThemedText variant="h4">Recent Plays</ThemedText>
        <ThemedText variant="caption" color="textTertiary">
          {events.length} total
        </ThemedText>
      </View>
      <FlatList
        data={displayEvents}
        renderItem={renderEvent}
        keyExtractor={(item) => item.id}
        scrollEnabled={false}
        contentContainerStyle={styles.list}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  list: {
    paddingLeft: spacing.sm,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingLeft: spacing.md,
    paddingBottom: spacing.md,
    borderLeftWidth: 2,
    marginLeft: spacing.sm,
  },
  eventRowFirst: {
    // First item styling if needed
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: -spacing.md - 17, // Offset to overlap border
    marginRight: spacing.md,
  },
  eventContent: {
    flex: 1,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  emptyContainer: {
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
});
