/**
 * Error State component for displaying errors
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from './ThemedText';
import { ThemedView } from './ThemedView';
import { Button } from './Button';
import { spacing } from '../theme';
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
  title,
  message,
  onRetry,
  retryLabel = 'Retry',
}) => {
  const { colors } = useTheme();
  const iconSize = getResponsiveValue(48, 64);

  return (
    <ThemedView variant="background" style={styles.container}>
      <Ionicons name="alert-circle-outline" size={iconSize} color={colors.error} />
      {title && (
        <ThemedText variant="h3" color="error" style={styles.title}>
          {title}
        </ThemedText>
      )}
      <ThemedText variant="body" color="textSecondary" style={styles.message}>
        {message}
      </ThemedText>
      {onRetry && (
        <Button
          title={retryLabel}
          onPress={onRetry}
          variant="primary"
          style={styles.button}
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
