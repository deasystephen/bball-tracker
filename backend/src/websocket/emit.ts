/**
 * Fire-and-forget emit helpers for game rooms.
 *
 * Services call these after persisting a change. The helpers pull the current
 * Socket.io server from the registry (see `io-registry.ts`) and no-op when no
 * server has been registered. Errors are logged but never thrown — a broken
 * real-time broadcast must never cause a write path to fail.
 */

import type { GameEvent, GameStatus } from '@prisma/client';
import { getIo } from './io-registry';
import { gameRoom } from './game-events';
import { logger } from '../utils/logger';

export interface GameScore {
  homeScore: number;
  awayScore: number;
}

export interface GameEventBroadcast {
  event: GameEvent & { player?: { id: string; name: string } | null };
  score: GameScore;
}

export function emitGameEvent(gameId: string, payload: GameEventBroadcast): void {
  const io = getIo();
  if (!io) return;
  try {
    io.to(gameRoom(gameId)).emit('game-event', payload);
  } catch (error) {
    logger.error('Failed to emit game-event', {
      gameId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface GameStatusChangeBroadcast {
  gameId: string;
  previousStatus: GameStatus;
  status: GameStatus;
  score: GameScore;
}

export function emitGameStatusChange(
  gameId: string,
  payload: GameStatusChangeBroadcast
): void {
  const io = getIo();
  if (!io) return;
  try {
    io.to(gameRoom(gameId)).emit('game-status-change', payload);
  } catch (error) {
    logger.error('Failed to emit game-status-change', {
      gameId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface GameEventRemovedBroadcast {
  gameId: string;
  eventId: string;
  /** Score after the event was removed. */
  score: GameScore;
}

export function emitGameEventRemoved(
  gameId: string,
  payload: GameEventRemovedBroadcast
): void {
  const io = getIo();
  if (!io) return;
  try {
    io.to(gameRoom(gameId)).emit('game-event-removed', payload);
  } catch (error) {
    logger.error('Failed to emit game-event-removed', {
      gameId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface GameScoreChangeBroadcast {
  gameId: string;
  score: GameScore;
}

/**
 * Broadcast a score edit that did not come from an event (opponent points,
 * manual corrections via `PATCH /games/:id`).
 */
export function emitGameScoreChange(
  gameId: string,
  payload: GameScoreChangeBroadcast
): void {
  const io = getIo();
  if (!io) return;
  try {
    io.to(gameRoom(gameId)).emit('game-score-change', payload);
  } catch (error) {
    logger.error('Failed to emit game-score-change', {
      gameId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
