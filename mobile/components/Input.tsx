/**
 * Themed Input/TextInput component
 */

import React, { useState } from 'react';
import {
  TextInput,
  TextInputProps,
  View,
  StyleSheet,
} from 'react-native';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { borderRadius } from '../theme/border-radius';
import { getResponsiveValue } from '../utils/responsive';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  helperText,
  leftIcon,
  rightIcon,
  style,
  onFocus,
  onBlur,
  ...props
}) => {
  const { colors } = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const padding = getResponsiveValue(12, 16);
  const fontSize = getResponsiveValue(16, 18);

  const getBorderColor = () => {
    if (error) return colors.error;
    if (isFocused) return colors.primary;
    return colors.inputBorder;
  };

  return (
    <View style={styles.container}>
      {label && (
        <ThemedText
          variant="captionBold"
          color="textSecondary"
          style={styles.label}
        >
          {label}
        </ThemedText>
      )}
      <View
        style={[
          styles.inputContainer,
          {
            backgroundColor: colors.inputBackground,
            borderColor: getBorderColor(),
            borderWidth: isFocused || error ? 2 : 1,
            borderRadius: borderRadius.md,
            paddingHorizontal: padding,
            paddingVertical: padding,
          },
        ]}
      >
        {leftIcon && <View style={styles.leftIcon}>{leftIcon}</View>}
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              fontSize,
              flex: 1,
              paddingLeft: leftIcon ? spacing.sm : 0,
              paddingRight: rightIcon ? spacing.sm : 0,
            },
          ]}
          placeholderTextColor={colors.inputPlaceholder}
          accessibilityLabel={label}
          accessibilityHint={error || helperText}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          {...props}
        />
        {rightIcon && <View style={styles.rightIcon}>{rightIcon}</View>}
      </View>
      {(error || helperText) && (
        <ThemedText
          variant="footnote"
          color={error ? 'error' : 'textTertiary'}
          style={styles.helperText}
        >
          {error || helperText}
        </ThemedText>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  label: {
    marginBottom: spacing.xs,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    padding: 0, // Remove default padding
  },
  leftIcon: {
    marginRight: spacing.xs,
  },
  rightIcon: {
    marginLeft: spacing.xs,
  },
  helperText: {
    marginTop: spacing.xs,
  },
});
