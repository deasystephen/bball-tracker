/**
 * Subscribe to a game room over Socket.io and expose live state.
 *
 * Lifecycle: on mount → join the room → install listeners → wait for snapshot.
 * On reconnect → re-join (server returns a fresh snapshot). On unmount →
 * remove listeners and leave the room (we keep the underlying socket open;
 * it's a singleton).
 *
 * Backend protocol contract — see backend/src/websocket/game-events.ts:
 *  - emit `join-game` with `{ gameId }` (ack: { success, gameId | error, code })
 *  - receive `game-snapshot`: { game, events } (events oldest-first)
 *  - receive `game-event`: { event, score }
 *  - receive `game-status-change`: { gameId, previousStatus, status, score }
 */

import { useEffect, useReducer, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '../services/socket';
import type { GameEvent, GameStatus } from '../types/game';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'error';

interface Score {
  homeScore: number;
  awayScore: number;
}

interface SnapshotGame {
  id: string;
  teamId: string;
  opponent: string;
  date: string;
  status: GameStatus;
  homeScore: number;
  awayScore: number;
}

interface GameSnapshotPayload {
  game: SnapshotGame;
  events: GameEvent[];
}

interface GameEventBroadcast {
  event: GameEvent;
  score: Score;
}

interface GameStatusChangeBroadcast {
  gameId: string;
  previousStatus: GameStatus;
  status: GameStatus;
  score: Score;
}

interface JoinAck {
  success: boolean;
  gameId?: string;
  error?: string;
  code?: string;
}

const EVENT_CAP = 20;

interface State {
  score: Score;
  status: GameStatus | null;
  events: GameEvent[]; // newest first, capped at EVENT_CAP
  connectionState: ConnectionState;
  error: string | null;
}

type Action =
  | { type: 'connecting' }
  | { type: 'reconnecting' }
  | { type: 'snapshot'; payload: GameSnapshotPayload }
  | { type: 'event'; payload: GameEventBroadcast }
  | { type: 'statusChange'; payload: GameStatusChangeBroadcast }
  | { type: 'error'; message: string };

const initialState: State = {
  score: { homeScore: 0, awayScore: 0 },
  status: null,
  events: [],
  connectionState: 'connecting',
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connecting':
      return { ...state, connectionState: 'connecting', error: null };
    case 'reconnecting':
      return { ...state, connectionState: 'reconnecting', error: null };
    case 'snapshot': {
      // Server returns events oldest-first; we render newest-first.
      const newest = [...action.payload.events].reverse().slice(0, EVENT_CAP);
      return {
        score: {
          homeScore: action.payload.game.homeScore,
          awayScore: action.payload.game.awayScore,
        },
        status: action.payload.game.status,
        events: newest,
        connectionState: 'live',
        error: null,
      };
    }
    case 'event': {
      const incoming = action.payload.event;
      // Dedupe — snapshot+stream race can deliver the same event twice.
      if (state.events.some((e) => e.id === incoming.id)) {
        return { ...state, score: action.payload.score };
      }
      const events = [incoming, ...state.events].slice(0, EVENT_CAP);
      return { ...state, score: action.payload.score, events };
    }
    case 'statusChange':
      return {
        ...state,
        status: action.payload.status,
        score: action.payload.score,
      };
    case 'error':
      return { ...state, connectionState: 'error', error: action.message };
    default:
      return state;
  }
}

export interface UseLiveGameResult {
  score: Score;
  status: GameStatus | null;
  events: GameEvent[];
  connectionState: ConnectionState;
  error: string | null;
}

export function useLiveGame(gameId: string | undefined): UseLiveGameResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!gameId) return;

    const socket = getSocket();
    socketRef.current = socket;

    const join = () => {
      socket.emit('join-game', { gameId }, (ack: JoinAck) => {
        if (!ack?.success) {
          dispatch({
            type: 'error',
            message: ack?.error ?? 'Failed to join game',
          });
        }
      });
    };

    const handleSnapshot = (payload: GameSnapshotPayload) => {
      if (payload?.game?.id !== gameId) return;
      dispatch({ type: 'snapshot', payload });
    };

    const handleEvent = (payload: GameEventBroadcast) => {
      if (payload?.event?.gameId !== gameId) return;
      dispatch({ type: 'event', payload });
    };

    const handleStatusChange = (payload: GameStatusChangeBroadcast) => {
      if (payload?.gameId !== gameId) return;
      dispatch({ type: 'statusChange', payload });
    };

    const handleConnect = () => {
      dispatch({ type: 'connecting' });
      join();
    };

    const handleDisconnect = () => {
      dispatch({ type: 'reconnecting' });
    };

    const handleConnectError = (err: Error) => {
      dispatch({ type: 'error', message: err.message });
    };

    socket.on('game-snapshot', handleSnapshot);
    socket.on('game-event', handleEvent);
    socket.on('game-status-change', handleStatusChange);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);

    if (socket.connected) {
      join();
    } else {
      socket.connect();
    }

    return () => {
      socket.off('game-snapshot', handleSnapshot);
      socket.off('game-event', handleEvent);
      socket.off('game-status-change', handleStatusChange);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.emit('leave-game', { gameId });
    };
  }, [gameId]);

  return state;
}
