/**
 * Themed Text component that adapts to light/dark mode
 */

import React from 'react';
import { Text, TextProps } from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { typography, TypographyVariant } from '../theme/typography';
import type { Colors } from '../theme/colors';

type ThemeColorKey = 'text' | 'textSecondary' | 'textTertiary' | 'primary' | 'error' | 'success';

interface ThemedTextProps extends TextProps {
  variant?: TypographyVariant;
  color?: ThemeColorKey;
  /**
   * Exposes the text as a heading (`accessibilityRole="header"`) so VoiceOver's
   * Headings rotor and TalkBack's heading navigation can jump to it. Opt-in, never
   * a variant default: the heading variants also render numbers (scores, record
   * counts, stat values), which must not be announced as headings. An explicit
   * `accessibilityRole` wins over this flag. Guard: `__tests__/a11y/heading-roles.test.ts`.
   */
  heading?: boolean;
}

const colorMap: Record<ThemeColorKey, keyof Colors> = {
  text: 'text',
  textSecondary: 'textSecondary',
  textTertiary: 'textTertiary',
  primary: 'primary',
  error: 'error',
  success: 'success',
};

export const ThemedText: React.FC<ThemedTextProps> = ({
  style,
  variant = 'body',
  color = 'text',
  heading = false,
  accessibilityRole,
  ...props
}) => {
  const { colors } = useTheme();
  const textColor = colors[colorMap[color]];

  return (
    <Text
      style={[
        typography[variant],
        { color: textColor },
        style,
      ]}
      accessibilityRole={accessibilityRole ?? (heading ? 'header' : undefined)}
      {...props}
    />
  );
};
