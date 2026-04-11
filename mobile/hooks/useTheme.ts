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
  const toColorScheme = (scheme: string | null | undefined): ColorScheme =>
    scheme === 'dark' ? 'dark' : 'light';

  const [systemColorScheme, setSystemColorScheme] = useState<ColorScheme>(
    toColorScheme(Appearance.getColorScheme())
  );

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(toColorScheme(colorScheme));
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
