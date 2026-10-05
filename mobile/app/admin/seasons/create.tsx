/**
 * Create Season screen
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
  SeasonDateFields,
} from '../../../components';
import { useToast } from '../../../components/Toast';
import { useLeague } from '../../../hooks/useLeagues';
import { useCreateSeason } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { canManageLeague } from '../../../utils/team-permissions';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { BackButton } from '../../../components/BackButton';

export default function CreateSeasonScreen() {
  const router = useRouter();
  const { leagueId } = useLocalSearchParams<{ leagueId: string }>();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [errors, setErrors] = useState<{ name?: string; leagueId?: string }>({});

  const { data: league, isLoading: leagueLoading } = useLeague(leagueId || '');
  const createSeason = useCreateSeason();
  const toast = useToast();

  // Season create needs system ADMIN or admin of *this* league
  // (backend `season-service.createSeason` → `isLeagueAdmin`).
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user,
    canManageLeague(user, leagueId),
    'Only admins of this league can create seasons',
    { fallback: '/admin' }
  );

  const validate = (): boolean => {
    const newErrors: { name?: string; leagueId?: string } = {};

    if (!name.trim()) {
      newErrors.name = 'Season name is required';
    }

    if (!leagueId) {
      newErrors.leagueId = 'League is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate() || !leagueId) return;

    try {
      await createSeason.mutateAsync({
        leagueId,
        name: name.trim(),
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString(),
      });

      toast.showToast('Season created successfully', 'success');
      router.back();
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to create season'
      );
    }
  };

  if (leagueLoading || !allowed) {
    return <LoadingSpinner message="Loading..." fullScreen />;
  }

  if (!leagueId || !league) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.md, paddingHorizontal: padding }]}>
          <BackButton onPress={() => router.back()} style={styles.backButton} />
          <ThemedText variant="h2" heading>Create Season</ThemedText>
        </View>
        <View style={styles.errorContainer}>
          <ThemedText variant="body" color="error">
            No league selected. Please select a league first.
          </ThemedText>
          <Button
            title="Go Back"
            variant="outline"
            onPress={() => router.back()}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: padding,
            paddingBottom: spacing.md,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading>Create Season</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            for {league.name}
          </ThemedText>
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { padding, paddingBottom: insets.bottom + spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <Input
            label="Season Name"
            placeholder="e.g., Spring 2024, Fall 2024"
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            autoFocus
          />

          <SeasonDateFields
            startDate={startDate}
            endDate={endDate}
            onChangeStart={setStartDate}
            onChangeEnd={setEndDate}
          />

          <View style={styles.buttonContainer}>
            <Button
              title="Create Season"
              onPress={handleSubmit}
              loading={createSeason.isPending}
              disabled={!name.trim()}
              fullWidth
              testID="season-create-submit"
            />
            <Button
              title="Cancel"
              variant="outline"
              onPress={() => router.back()}
              style={styles.cancelButton}
              fullWidth
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
