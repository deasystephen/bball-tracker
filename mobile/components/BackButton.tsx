/**
 * The header back control every pushed screen draws (the root `Stack` hides
 * the native header). One place for what VoiceOver, Maestro and the 44pt rule
 * need (#655, #772): `accessibilityRole="button"`, the label "Go back" (ten
 * Maestro flows `tapOn: "Go back"`, and the ErrorState way-back guard treats
 * a `BackButton` as the screen's own way back), a 24pt icon drawn at 40pt and
 * `HEADER_ICON_HIT_SLOP` to make it a 44pt target without moving it.
 *
 * The caller decides what going back means (`router.back()`, `useGoBack`, a
 * prop) and passes it as `onPress`; `style` carries only the margins that
 * place the button in its header.
 */

import React from 'react';
import { StyleSheet, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { HEADER_ICON_HIT_SLOP } from '../utils/touch-target';

const BACK_ICON_SIZE = 24;

export interface BackButtonProps {
  onPress: () => void;
  /** Margins that place the button in its header; the button sizes itself. */
  style?: StyleProp<ViewStyle>;
  /** Icon colour; defaults to the theme's text colour (white on the hero and immersive headers). */
  color?: string;
  /** `close` on a screen presented like a modal (game create). */
  icon?: 'arrow-back' | 'close';
}

export function BackButton({ onPress, style, color, icon = 'arrow-back' }: BackButtonProps) {
  const { colors } = useTheme();

  return (
    <View style={style}>
      <TouchableOpacity
        onPress={onPress}
        style={styles.button}
        hitSlop={HEADER_ICON_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name={icon} size={BACK_ICON_SIZE} color={color ?? colors.text} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { padding: spacing.sm },
});
