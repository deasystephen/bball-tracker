/**
 * Zustand store for live game tracking session state
 */

import { create } from 'zustand';
import type { GameEvent, CreateGameEventInput } from '../types/game';

interface LocalEvent extends CreateGameEventInput {
  localId: string;
  playerName?: string;
  createdAt: string;
}

interface GameTrackingState {
  // Selected player for recording events
  selectedPlayerId: string | null;
  selectedPlayerName: string | null;

  // Local events (for optimistic updates)
  localEvents: LocalEvent[];

  // Last event for undo functionality
  lastEvent: LocalEvent | null;

  // Undo timer ID
  undoTimerId: NodeJS.Timeout | null;

  // Actions
  selectPlayer: (playerId: string | null, playerName?: string | null) => void;
  recordEvent: (event: CreateGameEventInput, playerName?: string) => LocalEvent;
  removeLocalEvent: (localId: string) => void;
  clearLastEvent: () => void;
  undoLast: () => LocalEvent | null;
  setUndoTimer: (timerId: NodeJS.Timeout | null) => void;
  clearSession: () => void;
}

/**
 * Game tracking store for managing live stat recording session
 */
export const useGameTrackingStore = create<GameTrackingState>()((set, get) => ({
  selectedPlayerId: null,
  selectedPlayerName: null,
  localEvents: [],
  lastEvent: null,
  undoTimerId: null,

  selectPlayer: (playerId, playerName) => {
    set({
      selectedPlayerId: playerId,
      selectedPlayerName: playerName ?? null,
    });
  },

  recordEvent: (event, playerName) => {
    const localEvent: LocalEvent = {
      ...event,
      localId: `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      playerName,
      createdAt: new Date().toISOString(),
    };

    // Clear any existing undo timer
    const { undoTimerId } = get();
    if (undoTimerId) {
      clearTimeout(undoTimerId);
    }

    set((state) => ({
      localEvents: [localEvent, ...state.localEvents],
      lastEvent: localEvent,
      undoTimerId: null,
    }));

    return localEvent;
  },

  removeLocalEvent: (localId) => {
    set((state) => ({
      localEvents: state.localEvents.filter((e) => e.localId !== localId),
    }));
  },

  clearLastEvent: () => {
    const { undoTimerId } = get();
    if (undoTimerId) {
      clearTimeout(undoTimerId);
    }
    set({ lastEvent: null, undoTimerId: null });
  },

  undoLast: () => {
    const { lastEvent, undoTimerId } = get();
    if (!lastEvent) return null;

    if (undoTimerId) {
      clearTimeout(undoTimerId);
    }

    set((state) => ({
      localEvents: state.localEvents.filter(
        (e) => e.localId !== lastEvent.localId
      ),
      lastEvent: null,
      undoTimerId: null,
    }));

    return lastEvent;
  },

  setUndoTimer: (timerId) => {
    set({ undoTimerId: timerId });
  },

  clearSession: () => {
    const { undoTimerId } = get();
    if (undoTimerId) {
      clearTimeout(undoTimerId);
    }

    set({
      selectedPlayerId: null,
      selectedPlayerName: null,
      localEvents: [],
      lastEvent: null,
      undoTimerId: null,
    });
  },
}));
