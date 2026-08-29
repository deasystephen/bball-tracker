/**
 * Per-user persisted roster sort choice (team overview screen).
 *
 * Best-effort AsyncStorage with the same swallow-errors pattern as
 * `utils/role-onboarding.ts` — a storage failure just means the default
 * jersey order stands, never an error surfaced to the user.
 */

import { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    AsyncStorage.getItem(rosterSortStorageKey(userId))
      .then((stored) => {
        if (!cancelled && isRosterSortKey(stored)) {
          setSortKeyState(stored);
        }
      })
      .catch(() => {
        // Best effort: the default order stands.
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const setSortKey = useCallback(
    (key: RosterSortKey) => {
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
