/**
 * Color palette for light and dark modes
 */

export const colors = {
  light: {
    // Primary colors
    primary: '#1A3A5C',
    primaryDark: '#0F2540',
    primaryLight: '#2E5C8A',

    // Accent colors
    accent: '#FF6B35',
    accentLight: '#FF8C5E',
    accentDark: '#E55A28',

    // Background colors
    background: '#F8F9FB',
    backgroundSecondary: '#FFFFFF',
    backgroundTertiary: '#EEF1F5',

    // Text colors
    text: '#1A1D23',
    textSecondary: '#5A6275',
    textTertiary: '#9BA3B5',
    textInverse: '#FFFFFF',

    // Semantic colors
    success: '#22C55E',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#3B82F6',

    // Live indicator
    live: '#EF4444',
    liveBackground: '#FEF2F2',

    // Border colors
    border: '#E2E6ED',
    borderLight: '#F0F2F6',

    // Card colors
    card: '#FFFFFF',
    cardSecondary: '#F8F9FB',

    // Input colors
    inputBackground: '#FFFFFF',
    inputBorder: '#E2E6ED',
    inputPlaceholder: '#9BA3B5',

    // Tab bar
    tabBarBackground: '#FFFFFF',
    tabBarActive: '#1A3A5C',
    tabBarInactive: '#9BA3B5',
  },
  dark: {
    // Primary colors
    primary: '#4A9EFF',
    primaryDark: '#2E5C8A',
    primaryLight: '#6BB3FF',

    // Accent colors
    accent: '#FF8C5E',
    accentLight: '#FFAB85',
    accentDark: '#FF6B35',

    // Background colors
    background: '#0D1117',
    backgroundSecondary: '#161B22',
    backgroundTertiary: '#21262D',

    // Text colors
    text: '#F0F6FC',
    textSecondary: '#8B949E',
    textTertiary: '#6E7681',
    textInverse: '#0D1117',

    // Semantic colors
    success: '#3FB950',
    warning: '#D29922',
    error: '#F85149',
    info: '#58A6FF',

    // Live indicator
    live: '#F85149',
    liveBackground: '#3D1117',

    // Border colors
    border: '#30363D',
    borderLight: '#21262D',

    // Card colors
    card: '#161B22',
    cardSecondary: '#21262D',

    // Input colors
    inputBackground: '#161B22',
    inputBorder: '#30363D',
    inputPlaceholder: '#6E7681',

    // Tab bar
    tabBarBackground: '#0D1117',
    tabBarActive: '#4A9EFF',
    tabBarInactive: '#6E7681',
  },
};

export type ColorScheme = 'light' | 'dark';
export type Colors = typeof colors.light;
