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
import { formatShotDescription } from '../../../utils/shot-label';
import { getGameResult } from '../../../utils/game-result';
import type { CreateGameEventInput, ShotMetadata } from '../../../types/game';
import { useGoBack } from '../../../hooks/useGoBack';
import { useTranslation } from '../../../i18n';

const UNDO_DURATION = 5; // seconds

export default function TrackGameScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/games');
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBackToGame = useGoBack(`/games/${id}`);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

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
    t('games.trackNotAllowed'),
    { fallback: `/games/${id}`, mode: 'replace' }
  );

  // Store
  const {
    selectedPlayerId,
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
        Alert.alert(t('common.error'), t('tracker.opponentScoreFailed'));
      }
    },
    [opponentScore, id, updateGame, t]
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
      Alert.alert(t('common.error'), t('tracker.opponentScoreFailed'));
    }
  }, [opponentScore, id, updateGame, t]);

  // Every submit takes the next number, so a failed create can tell whether
  // the coach has recorded anything since it was sent.
  const submitSeq = useRef(0);

  // Record one event for the selected player. The selection is consumed
  // synchronously, before the POST goes out (#730): the player is deselected
  // in the same tick as the tap, which disables the shot and stat buttons, so
  // at most one event is in flight per selection. The live store is read
  // rather than the render's closure because a second tap can land before
  // React re-renders the disabled buttons; that tap finds no selection and
  // is dropped. A failed create gives the selection back for a one-tap retry,
  // but only if nothing was recorded since and no one else is selected:
  // after "A taps, B taps, A's POST fails" re-selecting A would make the
  // coach's next tap, meant for B, record for A. The error names the player
  // and the play either way.
  const submitEvent = useCallback(
    async (
      eventType: CreateGameEventInput['eventType'],
      metadata: CreateGameEventInput['metadata'],
      eventLabel: string
    ) => {
      const { selectedPlayerId: playerId, selectedPlayerName: playerName } =
        useGameTrackingStore.getState();
      if (!playerId) return;

      submitSeq.current += 1;
      const seq = submitSeq.current;
      const eventData: CreateGameEventInput = { playerId, eventType, metadata };

      // Record locally first (optimistic). UNDO stays disabled until the
      // server id is known (audit #7).
      const local = recordEvent(eventData, playerName || undefined);
      selectPlayer(null, null);

      try {
        // Create event on server. A SHOT response carries the
        // server-derived score, which the mutation writes into the game
        // cache.
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

        // Refetch events to sync
        refetchEvents();
      } catch (error) {
        // Remove local event on failure
        discardEvent(local.localId);
        const nothingSince = submitSeq.current === seq;
        if (nothingSince && !useGameTrackingStore.getState().selectedPlayerId) {
          selectPlayer(playerId, playerName);
        }
        const who = playerName || t('tracker.thisPlayer');
        const reason = error instanceof Error && error.message ? `\n\n${error.message}` : '';
        Alert.alert(t('common.error'), `${t('tracker.saveFailed', { play: eventLabel, player: who })}${reason}`);
      }
    },
    [
      id,
      recordEvent,
      confirmEvent,
      createEvent,
      clearLastEvent,
      setUndoTimer,
      selectPlayer,
      refetchEvents,
      discardEvent,
      t,
    ]
  );

  // Handle shot recording
  const handleShot = useCallback(
    (points: 1 | 2 | 3, made: boolean) => {
      // Typed here so a SHOT always carries valid ShotMetadata.
      const metadata: ShotMetadata = { made, points };
      return submitEvent('SHOT', metadata, formatShotDescription(metadata));
    },
    [submitEvent]
  );

  // Handle other stats (rebounds, steals, blocks, assists)
  const handleStat = useCallback(
    (statType: StatType) => {
      // Map stat type to event type and metadata
      let eventType: 'REBOUND' | 'STEAL' | 'BLOCK' | 'ASSIST';
      let metadata: Record<string, unknown> = {};
      let statLabel: string;

      switch (statType) {
        case 'OREB':
          eventType = 'REBOUND';
          metadata = { type: 'offensive' };
          statLabel = t('tracker.play.offRebound');
          break;
        case 'DREB':
          eventType = 'REBOUND';
          metadata = { type: 'defensive' };
          statLabel = t('tracker.play.defRebound');
          break;
        case 'STL':
          eventType = 'STEAL';
          statLabel = t('tracker.event.steal');
          break;
        case 'BLK':
          eventType = 'BLOCK';
          statLabel = t('tracker.event.block');
          break;
        case 'AST':
          eventType = 'ASSIST';
          statLabel = t('tracker.event.assist');
          break;
        default:
          return Promise.resolve();
      }

      return submitEvent(eventType, metadata, statLabel);
    },
    [submitEvent, t]
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
        eventType: target.eventType,
      });

      refetchEvents();
    } catch (error) {
      Alert.alert(
        t('common.error'),
        error instanceof Error ? error.message : t('tracker.undoFailed')
      );
    }
  }, [undoLast, id, deleteEvent, refetchEvents, t]);

  // Handle end game
  const handleEndGame = useCallback(() => {
    Alert.alert(t('games.endGame'), t('games.endGameConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('games.endGame'),
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
            if (getGameResult(homeScore, opponentScore) === 'W') {
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
              t('common.error'),
              error instanceof Error ? error.message : t('games.endFailed')
            );
          }
        },
      },
    ]);
  }, [id, updateGame, homeScore, opponentScore, clearSession, router, t]);

  // Handle back
  const handleBack = useCallback(() => {
    Alert.alert(
      t('games.leaveTrackingTitle'),
      t('games.leaveTrackingConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('games.leave'),
          onPress: () => {
            clearSession();
            router.back();
          },
        },
      ]
    );
  }, [clearSession, router, t]);

  // Loading state
  if (gameLoading || eventsLoading) {
    return <LoadingSpinner message={t('games.loadingGame')} fullScreen />;
  }

  // Error state
  if (gameError || !game) {
    return (
      <ErrorState
        message={gameError instanceof Error ? gameError.message : t('games.notFound')}
        onRetry={refetchGame}
        onBack={goBack}
      />
    );
  }

  // Never flash the tracker to someone being bounced out by the guard.
  if (!allowed) {
    return <LoadingSpinner message={t('games.loadingGame')} fullScreen />;
  }

  // Check if game is in progress
  if (game.status !== 'IN_PROGRESS') {
    return (
      <ErrorState
        message={t('games.notInProgress')}
        // Nothing to retry: the only way on is out.
        onBack={goBackToGame}
      />
    );
  }

  const players = game.team?.members || [];
  const displayEvents = events || [];

  // Get undo message based on event type
  const getUndoMessage = (): string => {
    if (!lastEvent) return '';

    const player = lastEvent.playerName || t('tracker.playerFallback');
    const undo = (play: string) => t('tracker.undoMessage', { player, play });

    switch (lastEvent.eventType) {
      case 'SHOT':
        return undo(formatShotDescription(lastEvent.metadata as ShotMetadata));
      case 'REBOUND': {
        const meta = lastEvent.metadata as { type?: string };
        return undo(
          meta?.type === 'offensive' ? t('tracker.play.offRebound') : t('tracker.play.defRebound')
        );
      }
      case 'ASSIST':
        return undo(t('tracker.event.assist'));
      case 'STEAL':
        return undo(t('tracker.event.steal'));
      case 'BLOCK':
        return undo(t('tracker.event.block'));
      case 'TURNOVER':
        return undo(t('tracker.event.turnover'));
      case 'FOUL':
        return undo(t('tracker.event.foul'));
      default:
        return undo(lastEvent.eventType);
    }
  };

  const undoMessage = getUndoMessage();

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Score Header */}
      <View style={{ paddingTop: insets.top }}>
        <ScoreDisplay
          homeTeamName={game.team?.name || t('games.yourTeam')}
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
