/**
 * Create Game screen
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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
  ListItem,
} from '../../components';
import { useCreateGame } from '../../hooks/useGames';
import { useTeams } from '../../hooks/useTeams';
import { useTheme } from '../../hooks/useTheme';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

export default function CreateGameScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [opponent, setOpponent] = useState('');
  const [teamId, setTeamId] = useState('');
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [errors, setErrors] = useState<{ opponent?: string; teamId?: string }>(
    {}
  );

  const { data: teams, isLoading: teamsLoading } = useTeams();
  const createGame = useCreateGame();

  const validate = (): boolean => {
    const newErrors: { opponent?: string; teamId?: string } = {};

    if (!opponent.trim()) {
      newErrors.opponent = 'Opponent name is required';
    }

    if (!teamId) {
      newErrors.teamId = 'Team is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    try {
      const game = await createGame.mutateAsync({
        teamId,
        opponent: opponent.trim(),
        date: date.toISOString(),
      });

      Alert.alert('Success', 'Game created successfully', [
        {
          text: 'OK',
          onPress: () => router.replace(`/games/${game.id}`),
        },
      ]);
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to create game'
      );
    }
  };

  const formatDate = (d: Date): string => {
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatTime = (d: Date): string => {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (teamsLoading) {
    return <LoadingSpinner message="Loading teams..." fullScreen />;
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header with back button */}
      <View
        style={[
          styles.topHeader,
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
          <ThemedText variant="h2" style={styles.headerTitle}>
            New Game
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
            label="Opponent"
            placeholder="Enter opponent team name"
            value={opponent}
            onChangeText={setOpponent}
            error={errors.opponent}
            autoCapitalize="words"
            autoFocus
          />

          {/* Team Selection */}
          <View style={styles.section}>
            <ThemedText
              variant="captionBold"
              color="textSecondary"
              style={styles.label}
            >
              Your Team
            </ThemedText>
            {teams && teams.length > 0 ? (
              <View style={[styles.teamList, { borderColor: colors.border }]}>
                {teams.map((team, index) => {
                  const isSelected = teamId === team.id;
                  const isLast = index === teams.length - 1;
                  return (
                    <ListItem
                      key={team.id}
                      title={team.name}
                      subtitle={team.season?.league?.name ? `${team.season.league.name} - ${team.season.name}` : undefined}
                      onPress={() => setTeamId(team.id)}
                      rightElement={
                        isSelected ? (
                          <Ionicons
                            name="checkmark-circle"
                            size={24}
                            color={colors.primary}
                          />
                        ) : (
                          <Ionicons
                            name="ellipse-outline"
                            size={24}
                            color={colors.textTertiary}
                          />
                        )
                      }
                      style={[
                        styles.teamItem,
                        isSelected && {
                          backgroundColor: colors.backgroundSecondary,
                        },
                        isLast && styles.lastItem,
                      ]}
                    />
                  );
                })}
              </View>
            ) : (
              <ThemedText
                variant="caption"
                color="textTertiary"
                style={styles.noTeams}
              >
                No teams available. Create a team first.
              </ThemedText>
            )}
            {errors.teamId && (
              <ThemedText
                variant="footnote"
                color="error"
                style={styles.errorText}
              >
                {errors.teamId}
              </ThemedText>
            )}
          </View>

          {/* Date Selection */}
          <View style={styles.section}>
            <ThemedText
              variant="captionBold"
              color="textSecondary"
              style={styles.label}
            >
              Game Date & Time
            </ThemedText>
            <TouchableOpacity
              style={[
                styles.dateButton,
                {
                  backgroundColor: colors.backgroundSecondary,
                  borderColor: colors.border,
                },
              ]}
              onPress={() => setShowDatePicker(true)}
            >
              <Ionicons
                name="calendar-outline"
                size={20}
                color={colors.primary}
              />
              <ThemedText variant="body">{formatDate(date)}</ThemedText>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.dateButton,
                {
                  backgroundColor: colors.backgroundSecondary,
                  borderColor: colors.border,
                },
              ]}
              onPress={() => setShowTimePicker(true)}
            >
              <Ionicons name="time-outline" size={20} color={colors.primary} />
              <ThemedText variant="body">{formatTime(date)}</ThemedText>
            </TouchableOpacity>
          </View>

          {showDatePicker && (
            <DateTimePicker
              value={date}
              mode="date"
              display="spinner"
              onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                setShowDatePicker(false);
                if (selectedDate) {
                  setDate(selectedDate);
                }
              }}
            />
          )}

          {showTimePicker && (
            <DateTimePicker
              value={date}
              mode="time"
              display="spinner"
              onChange={(event: DateTimePickerEvent, selectedDate?: Date) => {
                setShowTimePicker(false);
                if (selectedDate) {
                  setDate(selectedDate);
                }
              }}
            />
          )}

          <View style={styles.buttonContainer}>
            <Button
              title="Create Game"
              onPress={handleSubmit}
              loading={createGame.isPending}
              disabled={!opponent.trim() || !teamId}
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
  topHeader: {
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
  headerTitle: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  section: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  teamList: {
    marginTop: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  teamItem: {
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  lastItem: {
    borderBottomWidth: 0,
  },
  noTeams: {
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  errorText: {
    marginTop: spacing.xs,
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
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
