import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { persist, createJSONStorage } from 'zustand/middleware';
import { secureAuthStorage, clearPersistedAuth } from '../services/secure-storage';
import { User } from '../../shared/types';
import { trackEvent, identifyUser, resetUser, AnalyticsEvents } from '../services/analytics';
import { getSessionHooks } from './session-hooks';

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
   * api-client interceptor.
   */
  clearSession: () => void;
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
        identifyUser(user.id);
        trackEvent(AnalyticsEvents.USER_LOGGED_IN);
        set({ user, isAuthenticated: true, isLoading: false });
      },

      updateUser: (patch: Partial<User>) => {
        set((state) => (state.user ? { user: { ...state.user, ...patch } } : {}));
      },

      clearSession: () => {
        logoutEpoch += 1;
        const wasSignedIn = get().isAuthenticated || get().accessToken !== null;
        if (wasSignedIn) {
          trackEvent(AnalyticsEvents.USER_LOGGED_OUT);
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
        get().clearSession();
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
          console.warn('Auth storage rehydration failed; starting logged out', error);
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
