/**
 * Per-user persisted roster sort choice (team overview screen).
 *
 * Best-effort AsyncStorage with the same swallow-errors pattern as
 * `utils/role-onboarding.ts` — a storage failure just means the default
 * jersey order stands, never an error surfaced to the user.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RosterSortKey, isRosterSortKey } from '../utils/roster-sort';

const KEY_PREFIX = 'rosterSort:';

export const DEFAULT_ROSTER_SORT: RosterSortKey = 'jersey';

export function rosterSortStorageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function useRosterSortPreference(
  userId: string | undefined
): [RosterSortKey, (key: RosterSortKey) => void] {
  const [sortKey, setSortKeyState] = useState<RosterSortKey>(DEFAULT_ROSTER_SORT);
  // True once the user has picked a sort since the current userId's hydration
  // began — a late-resolving hydration must never stomp an explicit tap.
  const userChoseRef = useRef(false);

  useEffect(() => {
    // Hydration always lands on a definite value: the stored choice when it
    // is valid, otherwise the default. Re-running on a userId change (account
    // switch, logout) therefore resets the state too — one user's stored
    // choice never bleeds into another's view.
    userChoseRef.current = false;
    let cancelled = false;
    const hydrate = async (): Promise<RosterSortKey> => {
      if (!userId) return DEFAULT_ROSTER_SORT;
      try {
        const stored = await AsyncStorage.getItem(rosterSortStorageKey(userId));
        return isRosterSortKey(stored) ? stored : DEFAULT_ROSTER_SORT;
      } catch {
        // Best effort: the default order stands.
        return DEFAULT_ROSTER_SORT;
      }
    };
    hydrate().then((key) => {
      if (!cancelled && !userChoseRef.current) {
        setSortKeyState(key);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const setSortKey = useCallback(
    (key: RosterSortKey) => {
      userChoseRef.current = true;
      setSortKeyState(key);
      if (!userId) return;
      AsyncStorage.setItem(rosterSortStorageKey(userId), key).catch(() => {
        // Best effort: worst case the choice resets on the next visit.
      });
    },
    [userId]
  );

  return [sortKey, setSortKey];
}
