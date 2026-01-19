/**
 * Themed Input/TextInput component
 */

import React from 'react';
import {
  TextInput,
  TextInputProps,
  View,
  StyleSheet,
  Text,
} from 'react-native';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
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
  ...props
}) => {
  const { colors } = useTheme();
  const padding = getResponsiveValue(12, 16);
  const fontSize = getResponsiveValue(16, 18);

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
            borderColor: error ? colors.error : colors.inputBorder,
            borderWidth: 1,
            borderRadius: 8,
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
