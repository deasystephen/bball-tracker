/**
 * Zustand store for live game tracking session state
 */

import { create } from 'zustand';
import type { CreateGameEventInput, GameEvent, GameEventType, ShotMetadata } from '../types/game';

export interface LocalEvent extends CreateGameEventInput {
  localId: string;
  playerName?: string;
  createdAt: string;
  /**
   * Id of the persisted server event, set by `confirmEvent` once the create
   * resolves. Undo targets this id — never a guess from the events cache.
   */
  serverId?: string;
}

/** Minimal shape shared by local and server events for counter folding. */
interface CountableEvent {
  playerId?: string | null;
  eventType: GameEventType;
  metadata?: unknown;
}

/**
 * Per-player counters that drive hot-streak and milestone UI. They are
 * always *derived*: `seed` (folded from the server's event log when the
 * screen opens) + every local event still on record. Undo/discard simply
 * re-fold, so counters can never drift from the events (audit #75).
 */
export interface PlayerCounters {
  playerStreaks: Record<string, number>;
  playerPoints: Record<string, number>;
  playerRebounds: Record<string, number>;
  playerAssists: Record<string, number>;
}

const EMPTY_COUNTERS: PlayerCounters = {
  playerStreaks: {},
  playerPoints: {},
  playerRebounds: {},
  playerAssists: {},
};

const HOT_STREAK = 3;

function shotMeta(event: CountableEvent): ShotMetadata | undefined {
  const meta = event.metadata as Partial<ShotMetadata> | undefined;
  if (!meta || typeof meta !== 'object') return undefined;
  return { made: !!meta.made, points: (meta.points as number) || 2 } as ShotMetadata;
}

/** Apply one event to a set of counters, returning new counters. */
export function applyEventToCounters(
  counters: PlayerCounters,
  event: CountableEvent
): PlayerCounters {
  const pid = event.playerId;
  if (!pid) return counters;

  switch (event.eventType) {
    case 'SHOT': {
      const meta = shotMeta(event);
      const streaks = { ...counters.playerStreaks };
      const points = { ...counters.playerPoints };
      if (meta?.made) {
        streaks[pid] = (streaks[pid] || 0) + 1;
        points[pid] = (points[pid] || 0) + meta.points;
      } else {
        streaks[pid] = 0;
      }
      return { ...counters, playerStreaks: streaks, playerPoints: points };
    }
    case 'REBOUND':
      return {
        ...counters,
        playerRebounds: {
          ...counters.playerRebounds,
          [pid]: (counters.playerRebounds[pid] || 0) + 1,
        },
      };
    case 'ASSIST':
      return {
        ...counters,
        playerAssists: {
          ...counters.playerAssists,
          [pid]: (counters.playerAssists[pid] || 0) + 1,
        },
      };
    default:
      return counters;
  }
}

/** Fold events (in chronological order) onto a base set of counters. */
export function foldCounters(
  base: PlayerCounters,
  eventsChronological: readonly CountableEvent[]
): PlayerCounters {
  return eventsChronological.reduce(applyEventToCounters, base);
}

function hotPlayersFrom(streaks: Record<string, number>): Record<string, number> {
  const hot: Record<string, number> = {};
  for (const [playerId, streak] of Object.entries(streaks)) {
    if (streak >= HOT_STREAK) hot[playerId] = streak;
  }
  return hot;
}

function doubleDoubleCategories(c: PlayerCounters, pid: string): number {
  return [
    (c.playerPoints[pid] || 0) >= 10,
    (c.playerRebounds[pid] || 0) >= 10,
    (c.playerAssists[pid] || 0) >= 10,
  ].filter(Boolean).length;
}

/** Milestone crossed by going from `prev` to `next` for `pid`, if any. */
function detectMilestone(
  prev: PlayerCounters,
  next: PlayerCounters,
  pid: string,
  playerName?: string
): string | null {
  const name = playerName || 'Player';
  const prevPts = prev.playerPoints[pid] || 0;
  const newPts = next.playerPoints[pid] || 0;

  let milestone: string | null = null;
  if (newPts >= 20 && prevPts < 20) {
    milestone = `${name} hit 20 points!`;
  } else if (newPts >= 10 && prevPts < 10) {
    milestone = `${name} hit 10 points!`;
  }

  if (doubleDoubleCategories(next, pid) >= 2 && doubleDoubleCategories(prev, pid) < 2) {
    milestone = `${name} has a double-double!`;
  }

  return milestone;
}

interface GameTrackingState extends PlayerCounters {
  // Selected player for recording events
  selectedPlayerId: string | null;
  selectedPlayerName: string | null;

  // Local events (for optimistic updates), newest first
  localEvents: LocalEvent[];

  // Last event for undo functionality
  lastEvent: LocalEvent | null;

  // Undo timer ID
  undoTimerId: NodeJS.Timeout | null;

  // Counters folded from the server's event log when the session opened
  seedCounters: PlayerCounters;
  seededFromServer: boolean;

  // Hot players: playerId -> streak count (3+ consecutive made shots)
  hotPlayers: Record<string, number>;

  // Last milestone triggered (to avoid duplicate toasts)
  lastMilestone: string | null;

  // Actions
  selectPlayer: (playerId: string | null, playerName?: string | null) => void;
  /**
   * Seed streak/milestone counters from already-persisted events (newest
   * first, as returned by `GET /games/:id/events`). Call once when the
   * tracking screen opens so "Continue Tracking" doesn't restart everyone at
   * zero. Never fires a milestone toast.
   */
  seedFromEvents: (eventsNewestFirst: readonly GameEvent[]) => void;
  recordEvent: (event: CreateGameEventInput, playerName?: string) => LocalEvent;
  /** Attach the server id to a local event once the create has resolved. */
  confirmEvent: (localId: string, serverId: string) => void;
  /**
   * Drop a local event whose server create failed. If it's still the undo
   * target this behaves like `undoLast`; otherwise it's just removed.
   */
  discardEvent: (localId: string) => void;
  removeLocalEvent: (localId: string) => void;
  clearLastEvent: () => void;
  undoLast: () => LocalEvent | null;
  setUndoTimer: (timerId: NodeJS.Timeout | null) => void;
  clearSession: () => void;
}

/** Counters + hot list derived from the seed and the remaining local events. */
function deriveCounters(
  seed: PlayerCounters,
  localEventsNewestFirst: readonly LocalEvent[]
): PlayerCounters & { hotPlayers: Record<string, number> } {
  const counters = foldCounters(seed, [...localEventsNewestFirst].reverse());
  return { ...counters, hotPlayers: hotPlayersFrom(counters.playerStreaks) };
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
  seedCounters: EMPTY_COUNTERS,
  seededFromServer: false,
  ...EMPTY_COUNTERS,
  hotPlayers: {},
  lastMilestone: null,

  selectPlayer: (playerId, playerName) => {
    set({
      selectedPlayerId: playerId,
      selectedPlayerName: playerName ?? null,
    });
  },

  seedFromEvents: (eventsNewestFirst) => {
    const seed = foldCounters(EMPTY_COUNTERS, [...eventsNewestFirst].reverse());
    set((state) => ({
      seedCounters: seed,
      seededFromServer: true,
      ...deriveCounters(seed, state.localEvents),
    }));
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

    const state = get();
    const prev: PlayerCounters = {
      playerStreaks: state.playerStreaks,
      playerPoints: state.playerPoints,
      playerRebounds: state.playerRebounds,
      playerAssists: state.playerAssists,
    };
    const next = applyEventToCounters(prev, event);
    const milestone = event.playerId
      ? detectMilestone(prev, next, event.playerId, playerName)
      : null;

    set((s) => ({
      localEvents: [localEvent, ...s.localEvents],
      lastEvent: localEvent,
      undoTimerId: null,
      ...next,
      hotPlayers: hotPlayersFrom(next.playerStreaks),
      lastMilestone: milestone,
    }));

    return localEvent;
  },

  confirmEvent: (localId, serverId) => {
    set((state) => ({
      localEvents: state.localEvents.map((e) =>
        e.localId === localId ? { ...e, serverId } : e
      ),
      lastEvent:
        state.lastEvent?.localId === localId
          ? { ...state.lastEvent, serverId }
          : state.lastEvent,
    }));
  },

  discardEvent: (localId) => {
    const { lastEvent, undoLast, removeLocalEvent } = get();
    if (lastEvent?.localId === localId) {
      undoLast();
    } else {
      removeLocalEvent(localId);
    }
  },

  removeLocalEvent: (localId) => {
    set((state) => {
      const localEvents = state.localEvents.filter((e) => e.localId !== localId);
      return { localEvents, ...deriveCounters(state.seedCounters, localEvents) };
    });
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

    // Re-derive every counter from seed + remaining events so undoing a
    // made shot, a miss (streak restored), a rebound or an assist all revert
    // exactly (audit #75).
    set((state) => {
      const localEvents = state.localEvents.filter((e) => e.localId !== lastEvent.localId);
      return {
        localEvents,
        lastEvent: null,
        undoTimerId: null,
        ...deriveCounters(state.seedCounters, localEvents),
      };
    });

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
      seedCounters: EMPTY_COUNTERS,
      seededFromServer: false,
      ...EMPTY_COUNTERS,
      hotPlayers: {},
      lastMilestone: null,
    });
  },
}));
