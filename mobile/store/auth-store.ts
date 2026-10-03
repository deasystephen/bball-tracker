import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { persist, createJSONStorage } from 'zustand/middleware';
import { secureAuthStorage, clearPersistedAuth } from '../services/secure-storage';
import { User } from '../../shared/types';
import {
  trackEvent,
  identifyUser,
  resetUser,
  setUserProperties,
  appVersion,
  AnalyticsEvents,
  type AnalyticsEventProps,
  type AnalyticsUserProperties,
} from '../services/analytics';
import { log } from '../services/log';
import { getSessionHooks } from './session-hooks';

export type LogoutReason = AnalyticsEventProps['user_logged_out']['reason'];

/**
 * Amplitude user properties the auth store is the source for (#616): the
 * global role and what it says about the person. `is_parent` is true for a
 * PARENT role or for anyone with a guardian link, since a coach can also be a
 * parent. Team-derived properties come from `hooks/useTeams.ts`, the tier
 * from `hooks/useUsage.ts`.
 */
export function userPropertiesFrom(user: User): Partial<AnalyticsUserProperties> {
  return {
    role: user.role,
    is_parent: user.role === 'PARENT' || (user.guardianOf?.length ?? 0) > 0,
    is_player: user.role === 'PLAYER',
    app_version: appVersion(),
  };
}

interface AuthState {
  accessToken: string | null;
  /**
   * WorkOS refresh token. Access tokens are short-lived (minutes); the API
   * client swaps this for a new pair on the first 401 (see api-client.ts).
   * Null for dev-login sessions, which never expire server-side.
   */
  refreshToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setAuthToken: (token: string, refreshToken?: string | null) => void;
  setUser: (user: User) => void;
  /** Merge fields into the current user without re-firing login analytics. */
  updateUser: (patch: Partial<User>) => void;
  /**
   * User-initiated sign-out: unregister this device's push token and revoke
   * the WorkOS session (both best-effort), then `clearSession()`.
   */
  logout: () => Promise<void>;
  /**
   * Local-only sign-out: drop tokens/user, reset the socket and query cache.
   * Used directly when the session is already dead server-side (refresh
   * rejected) — no network calls, so it can never recurse through the
   * api-client interceptor. `reason` is the `user_logged_out` property;
   * the default is the api-client's case.
   */
  clearSession: (reason?: LogoutReason) => void;
}

/**
 * Incremented on every sign-out. The api-client captures it before a refresh
 * and discards the result if it changed, so a refresh that resolves after
 * logout cannot resurrect the session (audit #41).
 */
let logoutEpoch = 0;
export const getLogoutEpoch = (): number => logoutEpoch;

/** Zustand persist key (the AsyncStorage half); see services/secure-storage.ts. */
export const AUTH_STORAGE_KEY = 'auth-storage';

const CLEARED_SESSION = {
  accessToken: null,
  refreshToken: null,
  user: null,
  isAuthenticated: false,
  isLoading: false,
} as const;

/**
 * Auth store using Zustand for managing authentication state.
 * Persisted through `services/secure-storage.ts` (audit #52): the tokens go
 * to expo-secure-store (Keychain/Keystore), `user`/flags to AsyncStorage.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: true,

      setAuthToken: (token: string, refreshToken: string | null = null) => {
        set({ accessToken: token, refreshToken, isAuthenticated: true });
      },

      setUser: (user: User) => {
        identifyUser(user.id, userPropertiesFrom(user));
        trackEvent(AnalyticsEvents.USER_LOGGED_IN);
        set({ user, isAuthenticated: true, isLoading: false });
      },

      updateUser: (patch: Partial<User>) => {
        const current = get().user;
        if (!current) return;
        const user = { ...current, ...patch };
        set({ user });
        // Only the fields the user properties are derived from refresh them.
        if (patch.role !== undefined || patch.guardianOf !== undefined) {
          setUserProperties(userPropertiesFrom(user));
        }
      },

      clearSession: (reason: LogoutReason = 'session_expired') => {
        // Always: a refresh in flight must never resurrect a session (#41).
        logoutEpoch += 1;

        // Ending a session that has already ended does nothing (#582). Every
        // step below has a cost when it runs twice: the store write re-renders
        // each screen that subscribes to the whole store, and clearing the
        // query cache makes every mounted query fetch again — without a token,
        // so it answers 401, which used to call this again. That loop sent
        // about 100 requests in the two seconds before /login unmounted the
        // tabs, and spent the IP's rate limit.
        const { isAuthenticated, accessToken, refreshToken, user } = get();
        const hasSession =
          isAuthenticated || accessToken !== null || refreshToken !== null || user !== null;
        if (!hasSession) return;

        const wasSignedIn = isAuthenticated || accessToken !== null;
        if (wasSignedIn) {
          trackEvent(AnalyticsEvents.USER_LOGGED_OUT, { reason });
          resetUser();
        }
        set(CLEARED_SESSION);
        // Belt-and-braces: persist writes the cleared state too, but wipe the
        // keychain entries explicitly so a failed write can't leave a token.
        clearPersistedAuth(AUTH_STORAGE_KEY).catch(() => undefined);
        // Side effects live in services/session-logout.ts and are reached
        // through the session-hooks registry so this store never imports the
        // api-client (which imports this store). Audit #17 (socket identity)
        // and #19 (query cache).
        try {
          getSessionHooks().localCleanup?.();
        } catch {
          // Cleanup must never block a sign-out.
        }
      },

      logout: async () => {
        // Bump first so any refresh already in flight is discarded (#41),
        // then spend the still-valid access token on the remote steps.
        logoutEpoch += 1;
        if (get().accessToken) {
          try {
            await getSessionHooks().remoteLogout?.();
          } catch {
            // Best-effort; local sign-out always proceeds.
          }
        }
        get().clearSession('user');
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(() => secureAuthStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      // Called with (state, undefined) on success and (undefined, error) when
      // AsyncStorage is unreadable/corrupt. Both branches must clear
      // `isLoading`, or app/index.tsx shows "Loading…" forever (audit #34).
      // Use `set`, never mutate the passed state object (it is a snapshot).
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          log.warn('Auth storage rehydration failed; starting logged out', { error });
          useAuthStore.setState({
            accessToken: null,
            refreshToken: null,
            user: null,
            isAuthenticated: false,
            isLoading: false,
          });
          return;
        }
        if (__DEV__) {
          // In dev mode, always start logged out to avoid stale auth state
          useAuthStore.setState({
            accessToken: null,
            refreshToken: null,
            user: null,
            isAuthenticated: false,
            isLoading: false,
          });
          return;
        }
        useAuthStore.setState({ isLoading: false });
      },
    }
  )
);

/**
 * Granular selectors to prevent unnecessary re-renders.
 * Components that only need the user don't re-render when accessToken changes.
 */
export const useAuthUser = () => useAuthStore((state) => state.user);
export const useIsAuthenticated = () => useAuthStore((state) => state.isAuthenticated);
// Zustand v5 removed the `shallow` equality argument: a selector returning a
// new object every render makes `useSyncExternalStore`'s snapshot look like it
// changed on every render, causing an infinite re-render loop ("Maximum update
// depth exceeded"). `useShallow` shallow-compares the result so the snapshot is
// stable (the action fns are already stable store references).
export const useAuthActions = () =>
  useAuthStore(
    useShallow((state) => ({
      setAuthToken: state.setAuthToken,
      setUser: state.setUser,
      updateUser: state.updateUser,
      logout: state.logout,
      clearSession: state.clearSession,
    }))
  );
