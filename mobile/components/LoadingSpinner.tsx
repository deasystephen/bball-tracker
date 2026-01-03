/**
 * Loading Spinner component
 */

import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { ThemedText } from './ThemedText';
import { ThemedView } from './ThemedView';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';

interface LoadingSpinnerProps {
  message?: string;
  fullScreen?: boolean;
  size?: 'small' | 'large';
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  message,
  fullScreen = false,
  size = 'large',
}) => {
  const { colors } = useTheme();

  if (fullScreen) {
    return (
      <ThemedView variant="background" style={styles.fullScreen}>
        <ActivityIndicator size={size} color={colors.primary} />
        {message && (
          <ThemedText
            variant="body"
            color="textSecondary"
            style={styles.message}
          >
            {message}
          </ThemedText>
        )}
      </ThemedView>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size={size} color={colors.primary} />
      {message && (
        <ThemedText
          variant="body"
          color="textSecondary"
          style={styles.message}
        >
          {message}
        </ThemedText>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    padding: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
