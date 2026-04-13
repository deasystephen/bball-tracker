/**
 * Tests for game-tracking-store.
 *
 * Exercises the real behaviors of the live tracking session:
 * - player selection
 * - recording shots (made/missed) and how that affects streaks + hot list
 * - cumulative stat tracking and milestone detection (10pt, 20pt, double-double)
 * - undo semantics (lastEvent, streak revert on undoing a made shot)
 * - clearSession reset
 */

import { useGameTrackingStore } from '../../store/game-tracking-store';
import type { CreateGameEventInput } from '../../types/game';

const madeTwo: Omit<CreateGameEventInput, 'playerId'> = {
  eventType: 'SHOT',
  metadata: { made: true, points: 2 },
};

const missedTwo: Omit<CreateGameEventInput, 'playerId'> = {
  eventType: 'SHOT',
  metadata: { made: false, points: 2 },
};

const rebound: Omit<CreateGameEventInput, 'playerId'> = {
  eventType: 'REBOUND',
  metadata: { type: 'defensive' },
};

const assist: Omit<CreateGameEventInput, 'playerId'> = {
  eventType: 'ASSIST',
};

const recordForPlayer = (
  playerId: string,
  base: Omit<CreateGameEventInput, 'playerId'>,
  playerName?: string,
) =>
  useGameTrackingStore
    .getState()
    .recordEvent({ ...base, playerId } as CreateGameEventInput, playerName);

describe('game-tracking-store', () => {
  beforeEach(() => {
    useGameTrackingStore.getState().clearSession();
  });

  it('selectPlayer sets selected id + name', () => {
    useGameTrackingStore.getState().selectPlayer('p1', 'Alice');
    const s = useGameTrackingStore.getState();
    expect(s.selectedPlayerId).toBe('p1');
    expect(s.selectedPlayerName).toBe('Alice');
  });

  it('selectPlayer(null) clears the selection', () => {
    useGameTrackingStore.getState().selectPlayer('p1', 'Alice');
    useGameTrackingStore.getState().selectPlayer(null);
    const s = useGameTrackingStore.getState();
    expect(s.selectedPlayerId).toBeNull();
    expect(s.selectedPlayerName).toBeNull();
  });

  it('recordEvent prepends the event, assigns localId, and sets lastEvent', () => {
    const e1 = recordForPlayer('p1', madeTwo, 'Alice');
    const e2 = recordForPlayer('p1', missedTwo, 'Alice');

    const s = useGameTrackingStore.getState();
    expect(s.localEvents).toHaveLength(2);
    // Newest first.
    expect(s.localEvents[0].localId).toBe(e2.localId);
    expect(s.localEvents[1].localId).toBe(e1.localId);
    expect(s.lastEvent?.localId).toBe(e2.localId);
    expect(e1.localId).not.toBe(e2.localId);
  });

  it('made shots increment streak; misses reset it; 3+ promotes to hot list', () => {
    recordForPlayer('p1', madeTwo, 'Alice');
    recordForPlayer('p1', madeTwo, 'Alice');
    let s = useGameTrackingStore.getState();
    expect(s.playerStreaks.p1).toBe(2);
    expect(s.hotPlayers.p1).toBeUndefined();

    recordForPlayer('p1', madeTwo, 'Alice');
    s = useGameTrackingStore.getState();
    expect(s.playerStreaks.p1).toBe(3);
    expect(s.hotPlayers.p1).toBe(3);

    // A miss resets the streak and removes player from hot list.
    recordForPlayer('p1', missedTwo, 'Alice');
    s = useGameTrackingStore.getState();
    expect(s.playerStreaks.p1).toBe(0);
    expect(s.hotPlayers.p1).toBeUndefined();
  });

  it('tracks cumulative points and fires 10pt milestone once crossed', () => {
    // Five made 2s = 10 points → 10pt milestone.
    for (let i = 0; i < 4; i++) {
      recordForPlayer('p1', madeTwo, 'Alice');
    }
    expect(useGameTrackingStore.getState().lastMilestone).toBeNull();

    recordForPlayer('p1', madeTwo, 'Alice');
    const s = useGameTrackingStore.getState();
    expect(s.playerPoints.p1).toBe(10);
    expect(s.lastMilestone).toMatch(/Alice hit 10 points/);
  });

  it('fires 20pt milestone once crossed', () => {
    for (let i = 0; i < 9; i++) {
      recordForPlayer('p1', madeTwo, 'Alice');
    }
    expect(useGameTrackingStore.getState().playerPoints.p1).toBe(18);
    recordForPlayer('p1', madeTwo, 'Alice');
    const s = useGameTrackingStore.getState();
    expect(s.playerPoints.p1).toBe(20);
    expect(s.lastMilestone).toMatch(/Alice hit 20 points/);
  });

  it('detects a double-double on 10pts + 10 rebounds', () => {
    // 10 points
    for (let i = 0; i < 5; i++) recordForPlayer('p1', madeTwo, 'Alice');
    // 9 rebounds — still single category
    for (let i = 0; i < 9; i++) recordForPlayer('p1', rebound, 'Alice');
    expect(useGameTrackingStore.getState().lastMilestone ?? '').not.toMatch(/double-double/);

    // 10th rebound crosses the threshold.
    recordForPlayer('p1', rebound, 'Alice');
    const s = useGameTrackingStore.getState();
    expect(s.playerRebounds.p1).toBe(10);
    expect(s.lastMilestone).toMatch(/double-double/);
  });

  it('tracks assists and double-double via assists', () => {
    for (let i = 0; i < 5; i++) recordForPlayer('p1', madeTwo, 'Alice'); // 10 pts
    for (let i = 0; i < 9; i++) recordForPlayer('p1', assist, 'Alice');
    expect(useGameTrackingStore.getState().playerAssists.p1).toBe(9);

    recordForPlayer('p1', assist, 'Alice');
    const s = useGameTrackingStore.getState();
    expect(s.playerAssists.p1).toBe(10);
    expect(s.lastMilestone).toMatch(/double-double/);
  });

  it('undoLast returns null when no event recorded', () => {
    expect(useGameTrackingStore.getState().undoLast()).toBeNull();
  });

  it('undoLast removes the last event and decrements streak for a made shot', () => {
    recordForPlayer('p1', madeTwo, 'Alice');
    recordForPlayer('p1', madeTwo, 'Alice');
    expect(useGameTrackingStore.getState().playerStreaks.p1).toBe(2);

    const undone = useGameTrackingStore.getState().undoLast();
    expect(undone).not.toBeNull();

    const s = useGameTrackingStore.getState();
    expect(s.localEvents).toHaveLength(1);
    expect(s.lastEvent).toBeNull();
    expect(s.playerStreaks.p1).toBe(1);
  });

  it('undoLast of a made shot from a hot streak clears hot-player flag when streak drops below 3', () => {
    for (let i = 0; i < 3; i++) recordForPlayer('p1', madeTwo, 'Alice');
    expect(useGameTrackingStore.getState().hotPlayers.p1).toBe(3);

    useGameTrackingStore.getState().undoLast();
    const s = useGameTrackingStore.getState();
    expect(s.playerStreaks.p1).toBe(2);
    expect(s.hotPlayers.p1).toBeUndefined();
  });

  it('removeLocalEvent removes by localId', () => {
    const e1 = recordForPlayer('p1', madeTwo, 'Alice');
    const e2 = recordForPlayer('p1', missedTwo, 'Alice');

    useGameTrackingStore.getState().removeLocalEvent(e1.localId);
    const s = useGameTrackingStore.getState();
    expect(s.localEvents.map((e) => e.localId)).toEqual([e2.localId]);
  });

  it('clearLastEvent clears lastEvent and any pending undo timer', () => {
    recordForPlayer('p1', madeTwo, 'Alice');
    const timer = setTimeout(() => {}, 10_000);
    useGameTrackingStore.getState().setUndoTimer(timer);

    useGameTrackingStore.getState().clearLastEvent();
    const s = useGameTrackingStore.getState();
    expect(s.lastEvent).toBeNull();
    expect(s.undoTimerId).toBeNull();
  });

  it('setUndoTimer stores and can be replaced with null', () => {
    const t = setTimeout(() => {}, 10_000);
    useGameTrackingStore.getState().setUndoTimer(t);
    expect(useGameTrackingStore.getState().undoTimerId).toBe(t);
    useGameTrackingStore.getState().setUndoTimer(null);
    expect(useGameTrackingStore.getState().undoTimerId).toBeNull();
    clearTimeout(t);
  });

  it('clearSession resets all tracking state', () => {
    recordForPlayer('p1', madeTwo, 'Alice');
    recordForPlayer('p1', madeTwo, 'Alice');
    useGameTrackingStore.getState().selectPlayer('p1', 'Alice');

    useGameTrackingStore.getState().clearSession();

    const s = useGameTrackingStore.getState();
    expect(s.selectedPlayerId).toBeNull();
    expect(s.selectedPlayerName).toBeNull();
    expect(s.localEvents).toEqual([]);
    expect(s.lastEvent).toBeNull();
    expect(s.undoTimerId).toBeNull();
    expect(s.playerStreaks).toEqual({});
    expect(s.hotPlayers).toEqual({});
    expect(s.playerPoints).toEqual({});
    expect(s.playerRebounds).toEqual({});
    expect(s.playerAssists).toEqual({});
    expect(s.lastMilestone).toBeNull();
  });

  it('recording a new event clears any pending undo timer', () => {
    recordForPlayer('p1', madeTwo, 'Alice');
    const timer = setTimeout(() => {}, 10_000);
    useGameTrackingStore.getState().setUndoTimer(timer);
    expect(useGameTrackingStore.getState().undoTimerId).toBe(timer);

    recordForPlayer('p1', madeTwo, 'Alice');
    expect(useGameTrackingStore.getState().undoTimerId).toBeNull();
  });
});
