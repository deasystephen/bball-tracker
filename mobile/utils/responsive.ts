/**
 * Responsive utilities for iPhone and iPad layouts
 *
 * Uses dynamic dimension lookups so values update on orientation change
 * or window resize (iPad multitasking, web).
 */

import { Dimensions, Platform } from 'react-native';

// Breakpoints
export const BREAKPOINTS = {
  phone: 0,
  tablet: 768,
  desktop: 1024,
} as const;

// Platform constants (these never change at runtime)
export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';
export const isWeb = Platform.OS === 'web';

// Dynamic device detection (reads current window size each call)
export const getIsTablet = (): boolean =>
  Dimensions.get('window').width >= BREAKPOINTS.tablet;

export const getIsPhone = (): boolean =>
  Dimensions.get('window').width < BREAKPOINTS.tablet;

// Legacy static references (for backward compatibility in existing code)
const { width: initialWidth, height: initialHeight } = Dimensions.get('window');
export const isTablet = initialWidth >= BREAKPOINTS.tablet;
export const isPhone = initialWidth < BREAKPOINTS.tablet;
export const isDesktop = isWeb && initialWidth >= BREAKPOINTS.desktop;
export const isMobileWeb = isWeb && initialWidth < BREAKPOINTS.tablet;

// Responsive dimensions
export const getResponsiveValue = <T>(
  phoneValue: T,
  tabletValue: T
): T => {
  return getIsTablet() ? tabletValue : phoneValue;
};

// Responsive spacing
export const getResponsiveSpacing = (
  phoneSpacing: number,
  tabletSpacing: number
): number => {
  return getResponsiveValue(phoneSpacing, tabletSpacing);
};

// Responsive font size
export const getResponsiveFontSize = (
  phoneSize: number,
  tabletSize: number
): number => {
  return getResponsiveValue(phoneSize, tabletSize);
};

// Column calculations for grid layouts
export const getColumns = (phoneColumns: number, tabletColumns: number): number => {
  return getResponsiveValue(phoneColumns, tabletColumns);
};

// Max content width (for iPad)
export const MAX_CONTENT_WIDTH = 1200;
export const getContentWidth = (): number => {
  const currentWidth = Dimensions.get('window').width;
  if (currentWidth >= BREAKPOINTS.tablet) {
    return Math.min(currentWidth, MAX_CONTENT_WIDTH);
  }
  return currentWidth;
};

// Screen dimensions (dynamic getters)
export const getScreenWidth = (): number => Dimensions.get('window').width;
export const getScreenHeight = (): number => Dimensions.get('window').height;

// Legacy static references
export const screenWidth = initialWidth;
export const screenHeight = initialHeight;

// Safe area helpers
export const getHorizontalPadding = (): number => {
  return getResponsiveValue(16, 24);
};

export const getVerticalPadding = (): number => {
  return getResponsiveValue(16, 24);
};
