/**
 * Color palette for light and dark modes
 */

export const colors = {
  light: {
    // Primary colors
    primary: '#007AFF',
    primaryDark: '#0051D5',
    primaryLight: '#5AC8FA',
    
    // Background colors
    background: '#FFFFFF',
    backgroundSecondary: '#F2F2F7',
    backgroundTertiary: '#E5E5EA',
    
    // Text colors
    text: '#000000',
    textSecondary: '#3C3C43',
    textTertiary: '#8E8E93',
    textInverse: '#FFFFFF',
    
    // Semantic colors
    success: '#34C759',
    warning: '#FF9500',
    error: '#FF3B30',
    info: '#007AFF',
    
    // Border colors
    border: '#C6C6C8',
    borderLight: '#E5E5EA',
    
    // Card colors
    card: '#FFFFFF',
    cardSecondary: '#F2F2F7',
    
    // Input colors
    inputBackground: '#FFFFFF',
    inputBorder: '#C6C6C8',
    inputPlaceholder: '#8E8E93',
    
    // Tab bar
    tabBarBackground: '#F9F9F9',
    tabBarActive: '#007AFF',
    tabBarInactive: '#8E8E93',
  },
  dark: {
    // Primary colors
    primary: '#0A84FF',
    primaryDark: '#0051D5',
    primaryLight: '#5AC8FA',
    
    // Background colors
    background: '#000000',
    backgroundSecondary: '#1C1C1E',
    backgroundTertiary: '#2C2C2E',
    
    // Text colors
    text: '#FFFFFF',
    textSecondary: '#EBEBF5',
    textTertiary: '#8E8E93',
    textInverse: '#000000',
    
    // Semantic colors
    success: '#30D158',
    warning: '#FF9F0A',
    error: '#FF453A',
    info: '#0A84FF',
    
    // Border colors
    border: '#38383A',
    borderLight: '#2C2C2E',
    
    // Card colors
    card: '#1C1C1E',
    cardSecondary: '#2C2C2E',
    
    // Input colors
    inputBackground: '#1C1C1E',
    inputBorder: '#38383A',
    inputPlaceholder: '#8E8E93',
    
    // Tab bar
    tabBarBackground: '#1C1C1E',
    tabBarActive: '#0A84FF',
    tabBarInactive: '#8E8E93',
  },
};

export type ColorScheme = 'light' | 'dark';
export type Colors = typeof colors.light;
