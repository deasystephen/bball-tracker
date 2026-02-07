/**
 * Empty State component for when lists are empty
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from './ThemedText';
import { ThemedView } from './ThemedView';
import { Button } from './Button';
import { spacing } from '../theme';
import { getResponsiveValue } from '../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';

interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon = 'document-outline',
  title,
  message,
  actionLabel,
  onAction,
}) => {
  const { colors } = useTheme();
  const iconSize = getResponsiveValue(64, 80);

  return (
    <ThemedView
      variant="background"
      style={styles.container}
      accessibilityLabel={`${title}${message ? `. ${message}` : ''}`}
    >
      <Ionicons name={icon} size={iconSize} color={colors.textTertiary} />
      <ThemedText variant="h3" color="textSecondary" style={styles.title}>
        {title}
      </ThemedText>
      {message && (
        <ThemedText
          variant="body"
          color="textTertiary"
          style={styles.message}
        >
          {message}
        </ThemedText>
      )}
      {actionLabel && onAction && (
        <Button
          title={actionLabel}
          onPress={onAction}
          style={styles.button}
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
    minHeight: 300, // Ensure it has enough space even when not full screen
  },
  title: {
    marginTop: spacing.lg,
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
