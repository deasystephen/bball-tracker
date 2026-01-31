/**
 * Live stat tracking screen
 */

import React, { useEffect, useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, ScrollView, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, LoadingSpinner, ErrorState } from '../../../components';
import {
  ScoreDisplay,
  PlayerRoster,
  ShotButtons,
  StatButtons,
  EventTimeline,
  UndoBanner,
  OpponentScoreButtons,
} from '../../../components/game';
import type { StatType } from '../../../components/game/StatButtons';
import { useGame, useUpdateGame } from '../../../hooks/useGames';
import { useGameEvents, useCreateGameEvent, useDeleteGameEvent } from '../../../hooks/useGameEvents';
import { useGameTrackingStore } from '../../../store/game-tracking-store';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import type { GameEvent, ShotMetadata } from '../../../types/game';

const UNDO_DURATION = 5; // seconds

export default function TrackGameScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // Game data
  const { data: game, isLoading: gameLoading, error: gameError, refetch: refetchGame } = useGame(id);
  const { data: events, isLoading: eventsLoading, refetch: refetchEvents } = useGameEvents(id, { limit: 100 });
  const createEvent = useCreateGameEvent();
  const deleteEvent = useDeleteGameEvent();
  const updateGame = useUpdateGame();

  // Store
  const {
    selectedPlayerId,
    selectedPlayerName,
    lastEvent,
    selectPlayer,
    recordEvent,
    clearLastEvent,
    undoLast,
    setUndoTimer,
    clearSession,
  } = useGameTrackingStore();

  // Local opponent score (initialized from game data)
  const [opponentScore, setOpponentScore] = useState<number>(0);

  // Initialize opponent score from game data
  useEffect(() => {
    if (game?.awayScore !== undefined) {
      setOpponentScore(game.awayScore);
    }
  }, [game?.awayScore]);

  // Clear session when leaving
  useEffect(() => {
    return () => {
      clearSession();
    };
  }, [clearSession]);

  // Calculate home score from events
  const homeScore = useMemo(() => {
    if (!events) return 0;

    return events
      .filter((e) => e.eventType === 'SHOT')
      .reduce((sum, e) => {
        const metadata = e.metadata as ShotMetadata;
        if (metadata?.made) {
          return sum + (metadata.points || 0);
        }
        return sum;
      }, 0);
  }, [events]);

  // Handle opponent score changes
  const handleAddOpponentPoints = useCallback(
    async (points: number) => {
      const newScore = opponentScore + points;
      setOpponentScore(newScore);

      // Update on server
      try {
        await updateGame.mutateAsync({
          gameId: id,
          data: { awayScore: newScore },
        });
      } catch (error) {
        // Revert on error
        setOpponentScore(opponentScore);
        Alert.alert('Error', 'Failed to update opponent score');
      }
    },
    [opponentScore, id, updateGame]
  );

  const handleSubtractOpponentPoint = useCallback(async () => {
    if (opponentScore <= 0) return;

    const newScore = opponentScore - 1;
    setOpponentScore(newScore);

    // Update on server
    try {
      await updateGame.mutateAsync({
        gameId: id,
        data: { awayScore: newScore },
      });
    } catch (error) {
      // Revert on error
      setOpponentScore(opponentScore);
      Alert.alert('Error', 'Failed to update opponent score');
    }
  }, [opponentScore, id, updateGame]);

  // Handle shot recording
  const handleShot = useCallback(
    async (points: 2 | 3, made: boolean) => {
      if (!selectedPlayerId) {
        Alert.alert('Select Player', 'Please select a player before recording a shot.');
        return;
      }

      const eventData = {
        playerId: selectedPlayerId,
        eventType: 'SHOT' as const,
        metadata: { made, points },
      };

      // Record locally first (optimistic)
      const localEvent = recordEvent(eventData, selectedPlayerName || undefined);

      try {
        // Create event on server
        await createEvent.mutateAsync({
          gameId: id,
          data: eventData,
        });

        // Update home score on server if shot was made
        if (made) {
          const newHomeScore = homeScore + points;
          await updateGame.mutateAsync({
            gameId: id,
            data: { homeScore: newHomeScore },
          });
        }

        // Set up undo timer
        const timerId = setTimeout(() => {
          clearLastEvent();
        }, UNDO_DURATION * 1000);

        setUndoTimer(timerId);

        // Deselect player to prevent accidental double-taps
        selectPlayer(null, null);

        // Refetch events to sync
        refetchEvents();
      } catch (error) {
        // Remove local event on failure
        undoLast();
        Alert.alert(
          'Error',
          error instanceof Error ? error.message : 'Failed to record shot'
        );
      }
    },
    [
      selectedPlayerId,
      selectedPlayerName,
      id,
      homeScore,
      recordEvent,
      createEvent,
      updateGame,
      clearLastEvent,
      setUndoTimer,
      selectPlayer,
      refetchEvents,
      undoLast,
    ]
  );

  // Handle other stats (rebounds, steals, blocks, assists)
  const handleStat = useCallback(
    async (statType: StatType) => {
      if (!selectedPlayerId) {
        Alert.alert('Select Player', 'Please select a player before recording a stat.');
        return;
      }

      // Map stat type to event type and metadata
      let eventType: 'REBOUND' | 'STEAL' | 'BLOCK' | 'ASSIST';
      let metadata: Record<string, unknown> = {};
      let statLabel: string;

      switch (statType) {
        case 'OREB':
          eventType = 'REBOUND';
          metadata = { type: 'offensive' };
          statLabel = 'Off Rebound';
          break;
        case 'DREB':
          eventType = 'REBOUND';
          metadata = { type: 'defensive' };
          statLabel = 'Def Rebound';
          break;
        case 'STL':
          eventType = 'STEAL';
          statLabel = 'Steal';
          break;
        case 'BLK':
          eventType = 'BLOCK';
          statLabel = 'Block';
          break;
        case 'AST':
          eventType = 'ASSIST';
          statLabel = 'Assist';
          break;
        default:
          return;
      }

      const eventData = {
        playerId: selectedPlayerId,
        eventType,
        metadata,
      };

      // Record locally first (optimistic)
      recordEvent(eventData, selectedPlayerName || undefined);

      try {
        // Create event on server
        await createEvent.mutateAsync({
          gameId: id,
          data: eventData,
        });

        // Set up undo timer
        const timerId = setTimeout(() => {
          clearLastEvent();
        }, UNDO_DURATION * 1000);

        setUndoTimer(timerId);

        // Deselect player to prevent accidental double-taps
        selectPlayer(null, null);

        // Refetch events to sync
        refetchEvents();
      } catch (error) {
        // Remove local event on failure
        undoLast();
        Alert.alert(
          'Error',
          error instanceof Error ? error.message : `Failed to record ${statLabel}`
        );
      }
    },
    [
      selectedPlayerId,
      selectedPlayerName,
      id,
      recordEvent,
      createEvent,
      clearLastEvent,
      setUndoTimer,
      selectPlayer,
      refetchEvents,
      undoLast,
    ]
  );

  // Handle undo
  const handleUndo = useCallback(async () => {
    const undoneEvent = undoLast();
    if (!undoneEvent) return;

    // Find the most recent server event that matches
    if (events && events.length > 0) {
      const mostRecentEvent = events[0];
      try {
        await deleteEvent.mutateAsync({
          gameId: id,
          eventId: mostRecentEvent.id,
        });

        // If undoing a made shot, update the home score
        if (
          mostRecentEvent.eventType === 'SHOT' &&
          (mostRecentEvent.metadata as ShotMetadata)?.made
        ) {
          const points = (mostRecentEvent.metadata as ShotMetadata)?.points || 2;
          const newHomeScore = Math.max(0, homeScore - points);
          await updateGame.mutateAsync({
            gameId: id,
            data: { homeScore: newHomeScore },
          });
        }

        refetchEvents();
      } catch (error) {
        Alert.alert(
          'Error',
          error instanceof Error ? error.message : 'Failed to undo'
        );
      }
    }
  }, [undoLast, events, id, deleteEvent, homeScore, updateGame, refetchEvents]);

  // Handle end game
  const handleEndGame = useCallback(() => {
    Alert.alert('End Game', 'Are you sure you want to end this game?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Game',
        style: 'destructive',
        onPress: async () => {
          try {
            await updateGame.mutateAsync({
              gameId: id,
              data: {
                status: 'FINISHED',
                homeScore: homeScore,
                awayScore: opponentScore,
              },
            });
            clearSession();
            router.replace(`/games/${id}`);
          } catch (error) {
            Alert.alert(
              'Error',
              error instanceof Error ? error.message : 'Failed to end game'
            );
          }
        },
      },
    ]);
  }, [id, updateGame, homeScore, opponentScore, clearSession, router]);

  // Handle back
  const handleBack = useCallback(() => {
    Alert.alert(
      'Leave Tracking',
      'Are you sure you want to leave? You can continue tracking later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          onPress: () => {
            clearSession();
            router.back();
          },
        },
      ]
    );
  }, [clearSession, router]);

  // Loading state
  if (gameLoading || eventsLoading) {
    return <LoadingSpinner message="Loading game..." fullScreen />;
  }

  // Error state
  if (gameError || !game) {
    return (
      <ErrorState
        message={gameError instanceof Error ? gameError.message : 'Game not found'}
        onRetry={refetchGame}
      />
    );
  }

  // Check if game is in progress
  if (game.status !== 'IN_PROGRESS') {
    return (
      <ErrorState
        message="This game is not in progress"
        onRetry={() => router.back()}
      />
    );
  }

  const players = game.team?.members || [];
  const displayEvents = events || [];

  // Get undo message based on event type
  const getUndoMessage = (): string => {
    if (!lastEvent) return '';

    const playerName = lastEvent.playerName || 'Player';

    switch (lastEvent.eventType) {
      case 'SHOT': {
        const meta = lastEvent.metadata as ShotMetadata;
        return `${playerName} - ${meta?.points || 2}pt ${meta?.made ? 'made' : 'miss'}`;
      }
      case 'REBOUND': {
        const meta = lastEvent.metadata as { type?: string };
        const type = meta?.type === 'offensive' ? 'Off' : 'Def';
        return `${playerName} - ${type} Rebound`;
      }
      case 'ASSIST':
        return `${playerName} - Assist`;
      case 'STEAL':
        return `${playerName} - Steal`;
      case 'BLOCK':
        return `${playerName} - Block`;
      default:
        return `${playerName} - ${lastEvent.eventType}`;
    }
  };

  const undoMessage = getUndoMessage();

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Score Header */}
      <View style={{ paddingTop: insets.top }}>
        <ScoreDisplay
          homeTeamName={game.team?.name || 'Your Team'}
          awayTeamName={game.opponent}
          homeScore={homeScore}
          awayScore={opponentScore}
          onBack={handleBack}
          onEndGame={handleEndGame}
        />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Player Selector */}
        <PlayerRoster
          players={players}
          selectedPlayerId={selectedPlayerId}
          onSelectPlayer={selectPlayer}
        />

        {/* Shot Buttons */}
        <ShotButtons
          onShot={handleShot}
          disabled={!selectedPlayerId}
        />

        {/* Other Stats */}
        <StatButtons
          onStat={handleStat}
          disabled={!selectedPlayerId}
        />

        {/* Opponent Score Buttons */}
        <OpponentScoreButtons
          onAddPoints={handleAddOpponentPoints}
          onSubtractPoint={handleSubtractOpponentPoint}
        />

        {/* Event Timeline */}
        <EventTimeline events={displayEvents} maxEvents={10} />
      </ScrollView>

      {/* Undo Banner */}
      <UndoBanner
        visible={!!lastEvent}
        message={undoMessage}
        onUndo={handleUndo}
        duration={UNDO_DURATION}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xxl * 2,
  },
});
