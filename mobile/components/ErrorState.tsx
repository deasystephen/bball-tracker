/**
 * Error State component for displaying errors
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from './ThemedText';
import { ThemedView } from './ThemedView';
import { Button } from './Button';
import { spacing } from '../theme';
import { shadows } from '../theme/shadows';
import { borderRadius } from '../theme/border-radius';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { getResponsiveValue } from '../utils/responsive';

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try Again',
}) => {
  const { colors } = useTheme();
  const iconSize = getResponsiveValue(48, 64);

  return (
    <ThemedView
      variant="background"
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLabel={`Error: ${title}. ${message}`}
    >
      <View style={[styles.iconContainer, { backgroundColor: colors.liveBackground, ...shadows.sm }]}>
        <Ionicons name="alert-circle-outline" size={iconSize} color={colors.error} />
      </View>
      <ThemedText variant="h3" color="error" style={styles.title}>
        {title}
      </ThemedText>
      <ThemedText variant="body" color="textSecondary" style={styles.message}>
        {message}
      </ThemedText>
      {onRetry && (
        <Button
          title={retryLabel}
          onPress={onRetry}
          variant="primary"
          style={styles.button}
          accessibilityLabel={retryLabel}
          accessibilityRole="button"
        />
      )}
    </ThemedView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
  message: {
    marginTop: spacing.sm,
    textAlign: 'center',
    maxWidth: 400,
  },
  button: {
    marginTop: spacing.lg,
  },
});
