/**
 * Responsive utilities for iPhone and iPad layouts
 */

import { Dimensions, Platform } from 'react-native';

const { width, height } = Dimensions.get('window');

// Breakpoints
export const BREAKPOINTS = {
  phone: 0,
  tablet: 768,
  desktop: 1024,
} as const;

// Device detection
export const isTablet = width >= BREAKPOINTS.tablet;
export const isPhone = width < BREAKPOINTS.tablet;
export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';
export const isWeb = Platform.OS === 'web';
export const isDesktop = isWeb && width >= BREAKPOINTS.desktop;
export const isMobileWeb = isWeb && width < BREAKPOINTS.tablet;

// Responsive dimensions
export const getResponsiveValue = <T>(
  phoneValue: T,
  tabletValue: T
): T => {
  return isTablet ? tabletValue : phoneValue;
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
  if (isTablet) {
    return Math.min(width, MAX_CONTENT_WIDTH);
  }
  return width;
};

// Screen dimensions
export const screenWidth = width;
export const screenHeight = height;

// Safe area helpers
export const getHorizontalPadding = (): number => {
  return getResponsiveValue(16, 24);
};

export const getVerticalPadding = (): number => {
  return getResponsiveValue(16, 24);
};
