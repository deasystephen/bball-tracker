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
      {...props}
    />
  );
};
