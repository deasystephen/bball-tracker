import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { apiClient } from '../services/api-client';
import { useAuthStore, useIsAuthenticated } from '../store/auth-store';
import type { User } from '../../shared/types';

/** Minimum gap between two `GET /auth/me` re-syncs. */
export const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Fields the server may change out from under the cached session user. */
const SYNCED_FIELDS = ['role', 'leagueAdminOf', 'name', 'profilePictureUrl'] as const;

interface MeResponse {
  success: boolean;
  user: Partial<User>;
}

/**
 * Keeps the cached `auth-store.user` in step with the server.
 *
 * The user payload is only written at login, so a role change, a new
 * league-admin grant or a profile edit made elsewhere would not reach the
 * permission gates until the next sign-in. This hook re-fetches `GET /auth/me`
 * when the app returns to the foreground (and once when a session becomes
 * active), throttled to once per `SESSION_REFRESH_INTERVAL_MS`, and merges the
 * synced fields via `updateUser`. Failures are ignored — a 401 already runs
 * through the api-client refresh/logout path.
 */
export function useSessionRefresh(): void {
  const isAuthenticated = useIsAuthenticated();
  const lastSyncAt = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      lastSyncAt.current = 0;
      return;
    }

    const sync = async (): Promise<void> => {
      const now = Date.now();
      if (inFlight.current || now - lastSyncAt.current < SESSION_REFRESH_INTERVAL_MS) return;
      inFlight.current = true;
      lastSyncAt.current = now;
      try {
        const response = await apiClient.get<MeResponse>('/auth/me');
        const fresh = response.data?.user;
        if (!fresh || !useAuthStore.getState().isAuthenticated) return;
        const patch: Partial<User> = {};
        for (const field of SYNCED_FIELDS) {
          const value = fresh[field];
          if (value !== undefined) {
            Object.assign(patch, { [field]: value });
          }
        }
        useAuthStore.getState().updateUser(patch);
      } catch {
        // Best-effort; the cached user stays until the next foreground.
      } finally {
        inFlight.current = false;
      }
    };

    // A session that is already in the foreground (cold start / fresh login)
    // gets one immediate sync; later foregrounds go through the listener.
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') {
      void sync();
    }
    const onChange = (next: AppStateStatus): void => {
      if (next === 'active') void sync();
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [isAuthenticated]);
}
