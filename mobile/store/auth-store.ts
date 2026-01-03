import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User, UserRole } from '../../shared/types';

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setAuthToken: (token: string) => void;
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
      user: null,
      isAuthenticated: false,
      isLoading: true,

      setAuthToken: (token: string) => {
        set({ accessToken: token, isAuthenticated: true });
      },

      setUser: (user: User) => {
        set({ user, isAuthenticated: true, isLoading: false });
      },

      logout: () => {
        set({
          accessToken: null,
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
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        // Set isLoading to false after rehydration
        if (state) {
          state.isLoading = false;
        }
      },
    }
  )
);
