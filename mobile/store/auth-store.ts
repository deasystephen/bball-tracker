import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User } from '../../shared/types';
import { trackEvent, identifyUser, resetUser, AnalyticsEvents } from '../services/analytics';

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
  logout: () => void;
}

/**
 * Auth store using Zustand for managing authentication state
 * Persists to AsyncStorage for token persistence across app restarts
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
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

      logout: () => {
        trackEvent(AnalyticsEvents.USER_LOGGED_OUT);
        resetUser();
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // In dev mode, always start logged out to avoid stale auth state
          if (__DEV__) {
            state.accessToken = null;
            state.refreshToken = null;
            state.user = null;
            state.isAuthenticated = false;
          }
          state.isLoading = false;
        }
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
      logout: state.logout,
    }))
  );
