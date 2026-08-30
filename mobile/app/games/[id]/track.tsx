/**
 * Live stat tracking screen
 */

import React, { useEffect, useCallback, useState, useRef } from 'react';
import { View, StyleSheet, ScrollView, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import ConfettiCannon from 'react-native-confetti-cannon';
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
import { useAuthUser } from '../../../store/auth-store';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { getGamePermissions } from '../../../utils/game-permissions';
import { useToast } from '../../../components/Toast';
import { spacing } from '../../../theme';
import type { ShotMetadata } from '../../../types/game';

const UNDO_DURATION = 5; // seconds

export default function TrackGameScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();

  // Confetti ref
  const confettiRef = useRef<ConfettiCannon>(null);
  const [showConfetti, setShowConfetti] = useState(false);

  // Game data
  const { data: game, isLoading: gameLoading, error: gameError, refetch: refetchGame } = useGame(id);
  const { data: events, isLoading: eventsLoading, refetch: refetchEvents } = useGameEvents(id, { limit: 100 });
  const createEvent = useCreateGameEvent();
  const deleteEvent = useDeleteGameEvent();
  const updateGame = useUpdateGame();

  const { showToast } = useToast();

  // Recording events needs `canTrackStats` (backend game-event-service). The
  // tracker is deep-linkable, so guard here too: bounce to the game detail.
  const user = useAuthUser();
  const canTrack = getGamePermissions(game?.team, user).canTrack;
  const allowed = useAccessGuard(
    !!game && !!user,
    canTrack,
    'You do not have permission to track stats for this game',
    { fallback: `/games/${id}`, mode: 'replace' }
  );

  // Store
  const {
    selectedPlayerId,
    selectedPlayerName,
    lastEvent,
    hotPlayers,
    lastMilestone,
    selectPlayer,
    recordEvent,
    confirmEvent,
    discardEvent,
    clearLastEvent,
    undoLast,
    setUndoTimer,
    clearSession,
    seedFromEvents,
    seededFromServer,
  } = useGameTrackingStore();

  // Seed hot-streak / milestone counters from what's already on the server
  // so "Continue Tracking" doesn't restart everyone at zero (audit #75).
  // Runs once per session: clearSession() resets the flag on unmount.
  useEffect(() => {
    if (events && !seededFromServer) {
      seedFromEvents(events);
    }
  }, [events, seededFromServer, seedFromEvents]);

  // Show milestone toasts
  useEffect(() => {
    if (lastMilestone) {
      showToast(lastMilestone, 'success', 4000);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [lastMilestone, showToast]);

  // Opponent score follows the server value until the user edits it locally
  // (null = follow server). Local edits win over later server refreshes.
  const [opponentScoreOverride, setOpponentScoreOverride] = useState<number | null>(null);
  const opponentScore = opponentScoreOverride ?? game?.awayScore ?? 0;

  // Clear session when leaving
  useEffect(() => {
    return () => {
      clearSession();
    };
  }, [clearSession]);

  // Home score is derived server-side from the full event log and returned by
  // every event create/delete (see useCreateGameEvent), so the cached game
  // detail is authoritative. Summing the 100-event page here undercounted
  // long games (audit #6).
  const homeScore = game?.homeScore ?? 0;

  // Handle opponent score changes
  const handleAddOpponentPoints = useCallback(
    async (points: number) => {
      const newScore = opponentScore + points;
      setOpponentScoreOverride(newScore);

      // Update on server
      try {
        await updateGame.mutateAsync({
          gameId: id,
          data: { awayScore: newScore },
        });
      } catch {
        // Revert on error
        setOpponentScoreOverride(opponentScore);
        Alert.alert('Error', 'Failed to update opponent score');
      }
    },
    [opponentScore, id, updateGame]
  );

  const handleSubtractOpponentPoint = useCallback(async () => {
    if (opponentScore <= 0) return;

    const newScore = opponentScore - 1;
    setOpponentScoreOverride(newScore);

    // Update on server
    try {
      await updateGame.mutateAsync({
        gameId: id,
        data: { awayScore: newScore },
      });
    } catch {
      // Revert on error
      setOpponentScoreOverride(opponentScore);
      Alert.alert('Error', 'Failed to update opponent score');
    }
  }, [opponentScore, id, updateGame]);

  // Handle shot recording
  const handleShot = useCallback(
    async (points: 1 | 2 | 3, made: boolean) => {
      if (!selectedPlayerId) {
        Alert.alert('Select Player', 'Please select a player before recording a shot.');
        return;
      }

      const eventData = {
        playerId: selectedPlayerId,
        eventType: 'SHOT' as const,
        metadata: { made, points },
      };

      // Record locally first (optimistic). UNDO stays disabled until the
      // server id is known (audit #7).
      const local = recordEvent(eventData, selectedPlayerName || undefined);

      try {
        // Create event on server. The response carries the server-derived
        // score, which the mutation writes into the game cache.
        const { event } = await createEvent.mutateAsync({
          gameId: id,
          data: eventData,
        });
        confirmEvent(local.localId, event.id);

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
        discardEvent(local.localId);
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
      recordEvent,
      confirmEvent,
      createEvent,
      clearLastEvent,
      setUndoTimer,
      selectPlayer,
      refetchEvents,
      discardEvent,
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

      // Record locally first (optimistic). UNDO stays disabled until the
      // server id is known (audit #7).
      const local = recordEvent(eventData, selectedPlayerName || undefined);

      try {
        // Create event on server
        const { event } = await createEvent.mutateAsync({
          gameId: id,
          data: eventData,
        });
        confirmEvent(local.localId, event.id);

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
        discardEvent(local.localId);
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
      confirmEvent,
      createEvent,
      clearLastEvent,
      setUndoTimer,
      selectPlayer,
      refetchEvents,
      discardEvent,
    ]
  );

  // Handle undo — deletes the exact server event the banner refers to. The
  // banner is disabled until `confirmEvent` has attached the server id, so
  // we never fall back to guessing from the events cache (audit #7).
  const handleUndo = useCallback(async () => {
    const { lastEvent: target } = useGameTrackingStore.getState();
    if (!target?.serverId) return;

    const undoneEvent = undoLast();
    if (!undoneEvent) return;

    try {
      // The server recomputes the home score when a SHOT is removed and
      // returns it; the mutation writes it into the game cache.
      await deleteEvent.mutateAsync({
        gameId: id,
        eventId: target.serverId,
      });

      refetchEvents();
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to undo'
      );
    }
  }, [undoLast, id, deleteEvent, refetchEvents]);

  // Handle end game
  const handleEndGame = useCallback(() => {
    Alert.alert('End Game', 'Are you sure you want to end this game?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Game',
        style: 'destructive',
        onPress: async () => {
          try {
            // homeScore is server-derived; only the opponent score is ours.
            await updateGame.mutateAsync({
              gameId: id,
              data: {
                status: 'FINISHED',
                awayScore: opponentScore,
              },
            });

            // Confetti on win
            if (homeScore > opponentScore) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setShowConfetti(true);
              setTimeout(() => {
                clearSession();
                router.replace(`/games/${id}`);
              }, 2000);
            } else {
              clearSession();
              router.replace(`/games/${id}`);
            }
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

  // Never flash the tracker to someone being bounced out by the guard.
  if (!allowed) {
    return <LoadingSpinner message="Loading game..." fullScreen />;
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
        const points = meta?.points || 2;
        const shotLabel = points === 1 ? 'FT' : `${points}pt`;
        return `${playerName} - ${shotLabel} ${meta?.made ? 'made' : 'miss'}`;
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
          hotPlayers={hotPlayers}
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

      {/* Undo Banner — keyed by event so the countdown restarts per event */}
      <UndoBanner
        key={lastEvent?.localId ?? 'none'}
        visible={!!lastEvent}
        message={undoMessage}
        onUndo={handleUndo}
        duration={UNDO_DURATION}
        pending={!!lastEvent && !lastEvent.serverId}
      />

      {/* Confetti on win */}
      {showConfetti && (
        <ConfettiCannon
          ref={confettiRef}
          count={200}
          origin={{ x: -10, y: 0 }}
          autoStart
          fadeOut
        />
      )}
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
