/**
 * Theme store for managing color scheme (light/dark mode)
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ColorScheme } from '../theme/colors';

interface ThemeState {
  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => void;
  toggleColorScheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      colorScheme: 'light',
      setColorScheme: (scheme) => set({ colorScheme: scheme }),
      toggleColorScheme: () =>
        set((state) => ({
          colorScheme: state.colorScheme === 'light' ? 'dark' : 'light',
        })),
    }),
    {
      name: 'theme-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
