/**
 * Zustand store for live game tracking session state
 */

import { create } from 'zustand';
import type { GameEvent, CreateGameEventInput, ShotMetadata } from '../types/game';

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

  // Streak tracking: consecutive made shots per player
  playerStreaks: Record<string, number>;

  // Hot players: playerId -> streak count (3+ consecutive made shots)
  hotPlayers: Record<string, number>;

  // Per-player cumulative stats for milestone detection
  playerPoints: Record<string, number>;
  playerRebounds: Record<string, number>;
  playerAssists: Record<string, number>;

  // Last milestone triggered (to avoid duplicate toasts)
  lastMilestone: string | null;

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
  playerStreaks: {},
  hotPlayers: {},
  playerPoints: {},
  playerRebounds: {},
  playerAssists: {},
  lastMilestone: null,

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

    // Update streak tracking
    const { playerStreaks } = get();
    const newStreaks = { ...playerStreaks };

    if (event.eventType === 'SHOT' && event.playerId) {
      const metadata = event.metadata as ShotMetadata | undefined;
      if (metadata?.made) {
        // Increment streak on made shot
        newStreaks[event.playerId] = (newStreaks[event.playerId] || 0) + 1;
      } else {
        // Reset streak on miss
        newStreaks[event.playerId] = 0;
      }
    }

    // Build hot players map (3+ consecutive made shots)
    const newHotPlayers: Record<string, number> = {};
    for (const [playerId, streak] of Object.entries(newStreaks)) {
      if (streak >= 3) {
        newHotPlayers[playerId] = streak;
      }
    }

    // Track per-player cumulative stats for milestones
    const { playerPoints, playerRebounds, playerAssists } = get();
    const newPlayerPoints = { ...playerPoints };
    const newPlayerRebounds = { ...playerRebounds };
    const newPlayerAssists = { ...playerAssists };
    let milestone: string | null = null;

    if (event.playerId) {
      const pid = event.playerId;

      if (event.eventType === 'SHOT') {
        const metadata = event.metadata as ShotMetadata | undefined;
        if (metadata?.made) {
          const prevPts = newPlayerPoints[pid] || 0;
          const newPts = prevPts + (metadata.points || 2);
          newPlayerPoints[pid] = newPts;

          // Check point milestones (10, 20, 30...)
          if (newPts >= 20 && prevPts < 20) {
            milestone = `${playerName || 'Player'} hit 20 points!`;
          } else if (newPts >= 10 && prevPts < 10) {
            milestone = `${playerName || 'Player'} hit 10 points!`;
          }

          // Check double-double
          const reb = newPlayerRebounds[pid] || 0;
          const ast = newPlayerAssists[pid] || 0;
          const categories = [newPts >= 10, reb >= 10, ast >= 10].filter(Boolean).length;
          if (categories >= 2) {
            const prevCategories = [prevPts >= 10, reb >= 10, ast >= 10].filter(Boolean).length;
            if (prevCategories < 2) {
              milestone = `${playerName || 'Player'} has a double-double!`;
            }
          }
        }
      } else if (event.eventType === 'REBOUND') {
        const prevReb = newPlayerRebounds[pid] || 0;
        newPlayerRebounds[pid] = prevReb + 1;
        const newReb = prevReb + 1;

        // Check double-double with rebounds
        const pts = newPlayerPoints[pid] || 0;
        const ast = newPlayerAssists[pid] || 0;
        const categories = [pts >= 10, newReb >= 10, ast >= 10].filter(Boolean).length;
        if (categories >= 2) {
          const prevCategories = [pts >= 10, prevReb >= 10, ast >= 10].filter(Boolean).length;
          if (prevCategories < 2) {
            milestone = `${playerName || 'Player'} has a double-double!`;
          }
        }
      } else if (event.eventType === 'ASSIST') {
        const prevAst = newPlayerAssists[pid] || 0;
        newPlayerAssists[pid] = prevAst + 1;
        const newAst = prevAst + 1;

        // Check double-double with assists
        const pts = newPlayerPoints[pid] || 0;
        const reb = newPlayerRebounds[pid] || 0;
        const categories = [pts >= 10, reb >= 10, newAst >= 10].filter(Boolean).length;
        if (categories >= 2) {
          const prevCategories = [pts >= 10, reb >= 10, prevAst >= 10].filter(Boolean).length;
          if (prevCategories < 2) {
            milestone = `${playerName || 'Player'} has a double-double!`;
          }
        }
      }
    }

    set((state) => ({
      localEvents: [localEvent, ...state.localEvents],
      lastEvent: localEvent,
      undoTimerId: null,
      playerStreaks: newStreaks,
      hotPlayers: newHotPlayers,
      playerPoints: newPlayerPoints,
      playerRebounds: newPlayerRebounds,
      playerAssists: newPlayerAssists,
      lastMilestone: milestone,
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

    // Revert streak if the undone event was a shot
    const { playerStreaks } = get();
    const newStreaks = { ...playerStreaks };

    if (lastEvent.eventType === 'SHOT' && lastEvent.playerId) {
      const metadata = lastEvent.metadata as ShotMetadata | undefined;
      if (metadata?.made) {
        // Decrement streak (undo a made shot)
        newStreaks[lastEvent.playerId] = Math.max(0, (newStreaks[lastEvent.playerId] || 0) - 1);
      } else {
        // Can't easily restore previous streak on undo of a miss, leave as is
      }
    }

    const newHotPlayers: Record<string, number> = {};
    for (const [playerId, streak] of Object.entries(newStreaks)) {
      if (streak >= 3) {
        newHotPlayers[playerId] = streak;
      }
    }

    set((state) => ({
      localEvents: state.localEvents.filter(
        (e) => e.localId !== lastEvent.localId
      ),
      lastEvent: null,
      undoTimerId: null,
      playerStreaks: newStreaks,
      hotPlayers: newHotPlayers,
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
      playerStreaks: {},
      hotPlayers: {},
      playerPoints: {},
      playerRebounds: {},
      playerAssists: {},
      lastMilestone: null,
    });
  },
}));
