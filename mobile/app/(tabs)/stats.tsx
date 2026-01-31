/**
 * Stats screen - view statistics and analytics
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedView, ThemedText, EmptyState } from '../../components';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

export default function Stats() {
  const { colors } = useTheme();
  const padding = getHorizontalPadding();

  return (
    <ThemedView variant="background" style={styles.container}>
      <View style={[styles.header, { paddingHorizontal: padding }]}>
        <ThemedText variant="h1">Statistics</ThemedText>
      </View>
      <EmptyState
        icon="stats-chart-outline"
        title="No Statistics Yet"
        message="Player and team statistics will appear here once games are played. Track points, rebounds, assists, and more!"
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
});
