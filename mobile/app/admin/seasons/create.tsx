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
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
} from '../../../components';
import { useLeague } from '../../../hooks/useLeagues';
import { useCreateSeason } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';

export default function CreateSeasonScreen() {
  const router = useRouter();
  const { leagueId } = useLocalSearchParams<{ leagueId: string }>();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; leagueId?: string }>({});

  const { data: league, isLoading: leagueLoading } = useLeague(leagueId || '');
  const createSeason = useCreateSeason();

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

      Alert.alert('Success', 'Season created successfully', [
        {
          text: 'OK',
          onPress: () => router.back(),
        },
      ]);
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to create season'
      );
    }
  };

  const formatDate = (date: Date | null): string => {
    if (!date) return 'Not set';
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (leagueLoading) {
    return <LoadingSpinner message="Loading..." fullScreen />;
  }

  if (!leagueId || !league) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.md, paddingHorizontal: padding }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <ThemedText variant="h2">Create Season</ThemedText>
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
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2">Create Season</ThemedText>
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

          {/* Date Pickers */}
          <View style={styles.section}>
            <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
              Season Dates (Optional)
            </ThemedText>

            <TouchableOpacity
              style={[
                styles.dateButton,
                {
                  backgroundColor: colors.backgroundSecondary,
                  borderColor: colors.border,
                },
              ]}
              onPress={() => setShowStartPicker(true)}
            >
              <Ionicons name="calendar-outline" size={20} color={colors.primary} />
              <View style={styles.dateContent}>
                <ThemedText variant="caption" color="textSecondary">
                  Start Date
                </ThemedText>
                <ThemedText variant="body">{formatDate(startDate)}</ThemedText>
              </View>
              {startDate && (
                <TouchableOpacity
                  onPress={() => setStartDate(null)}
                  style={styles.clearButton}
                >
                  <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.dateButton,
                {
                  backgroundColor: colors.backgroundSecondary,
                  borderColor: colors.border,
                },
              ]}
              onPress={() => setShowEndPicker(true)}
            >
              <Ionicons name="calendar-outline" size={20} color={colors.primary} />
              <View style={styles.dateContent}>
                <ThemedText variant="caption" color="textSecondary">
                  End Date
                </ThemedText>
                <ThemedText variant="body">{formatDate(endDate)}</ThemedText>
              </View>
              {endDate && (
                <TouchableOpacity
                  onPress={() => setEndDate(null)}
                  style={styles.clearButton}
                >
                  <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          </View>

          {showStartPicker && (
            <DateTimePicker
              value={startDate || new Date()}
              mode="date"
              display="spinner"
              onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                setShowStartPicker(false);
                if (selectedDate) {
                  setStartDate(selectedDate);
                }
              }}
            />
          )}

          {showEndPicker && (
            <DateTimePicker
              value={endDate || new Date()}
              mode="date"
              display="spinner"
              onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                setShowEndPicker(false);
                if (selectedDate) {
                  setEndDate(selectedDate);
                }
              }}
            />
          )}

          <View style={styles.buttonContainer}>
            <Button
              title="Create Season"
              onPress={handleSubmit}
              loading={createSeason.isPending}
              disabled={!name.trim()}
              fullWidth
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
    padding: spacing.sm,
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
  section: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: spacing.sm,
  },
  dateContent: {
    flex: 1,
  },
  clearButton: {
    padding: spacing.xs,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
