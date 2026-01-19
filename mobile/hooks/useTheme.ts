/**
 * Hook to access theme colors and utilities
 */

import { useThemeStore } from '../store/theme-store';
import { colors, Colors, ColorScheme } from '../theme/colors';
import { Appearance } from 'react-native';
import { useEffect, useState } from 'react';

/**
 * Hook to get current theme colors
 * Automatically uses system color scheme if user hasn't set a preference
 */
export function useTheme(): { colors: Colors; colorScheme: ColorScheme } {
  const userColorScheme = useThemeStore((state) => state.colorScheme);
  const [systemColorScheme, setSystemColorScheme] = useState<ColorScheme>(
    Appearance.getColorScheme() || 'light'
  );

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(colorScheme || 'light');
    });

    return () => subscription.remove();
  }, []);

  // Use user preference if set, otherwise fall back to system
  const colorScheme = userColorScheme || systemColorScheme;

  return {
    colors: colors[colorScheme],
    colorScheme,
  };
}
