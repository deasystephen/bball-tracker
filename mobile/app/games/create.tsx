/**
 * Create Game screen
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
  ListItem,
  Card,
} from '../../components';
import { DateTimePickerSheet, DateTimePickerSheetMode } from '../../components/DateTimePickerSheet';
import { useToast } from '../../components/Toast';
import { useCreateGame } from '../../hooks/useGames';
import { useTeams, TEAMS_MAX_LIMIT, hasTeamPermission } from '../../hooks/useTeams';
import { useTheme } from '../../hooks/useTheme';
import { useAccessGuard } from '../../hooks/useAccessGuard';
import { useAuthUser } from '../../store/auth-store';
import { spacing } from '../../theme';
import { borderRadius } from '../../theme/border-radius';
import { getHorizontalPadding } from '../../utils/responsive';
import { BackButton } from '../../components/BackButton';

export default function CreateGameScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [opponent, setOpponent] = useState('');
  const [teamId, setTeamId] = useState('');
  const [date, setDate] = useState(new Date());
  const [picker, setPicker] = useState<DateTimePickerSheetMode | null>(null);
  const [errors, setErrors] = useState<{ opponent?: string; teamId?: string }>(
    {}
  );

  const { data: allTeams, isLoading: teamsLoading } = useTeams({ limit: TEAMS_MAX_LIMIT });
  const createGame = useCreateGame();
  const toast = useToast();
  const user = useAuthUser();

  // Only teams the user can manage are offered — creating a game needs
  // `canManageTeam` on that team (backend `game-service.createGame`).
  const teams = useMemo(
    () =>
      (allTeams ?? []).filter((team) =>
        hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf)
      ),
    [allTeams, user]
  );
  // Deep links / stale screens can still land here; bounce users who cannot
  // manage any team before they fill in a form the API will reject with 403.
  const allowed = useAccessGuard(
    !teamsLoading && !!user,
    teams.length > 0,
    'You need a team-manager or coach role to schedule games',
    { fallback: '/(tabs)/games' }
  );

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

      toast.showToast('Game created successfully', 'success');
      router.replace(`/games/${game.id}`);
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to create game'
      );
    }
  };

  const openPicker = (mode: DateTimePickerSheetMode) => {
    // The opponent field takes focus when the screen opens; its keyboard
    // would otherwise sit on top of the sheet.
    Keyboard.dismiss();
    setPicker(mode);
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

  if (teamsLoading || !allowed) {
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
        <BackButton onPress={() => router.back()} style={styles.backButton} icon="close" />
        <View style={styles.headerContent}>
          <ThemedText variant="h3" numberOfLines={1}>
            New Game
          </ThemedText>
        </View>
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={!opponent.trim() || !teamId || createGame.isPending}
          style={styles.headerAction}
          accessibilityRole="button"
          accessibilityLabel="Create game"
        >
          <ThemedText
            variant="bodyBold"
            style={{
              color: (!opponent.trim() || !teamId) ? colors.textTertiary : colors.primary,
            }}
          >
            Create
          </ThemedText>
        </TouchableOpacity>
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
          {/* Opponent Section */}
          <Card variant="default" style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Ionicons name="basketball-outline" size={20} color={colors.primary} />
              <ThemedText variant="captionBold" color="textSecondary">
                Opponent
              </ThemedText>
            </View>
            <Input
              placeholder="Enter opponent team name"
              value={opponent}
              onChangeText={setOpponent}
              error={errors.opponent}
              autoCapitalize="words"
              autoFocus
              testID="opponent-name-input"
            />
          </Card>

          {/* Team Selection */}
          <Card variant="default" style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Ionicons name="people-outline" size={20} color={colors.primary} />
              <ThemedText variant="captionBold" color="textSecondary">
                Your Team
              </ThemedText>
            </View>
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
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
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
                          backgroundColor: colors.primary + '10',
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
          </Card>

          {/* Date Selection */}
          <Card variant="default" style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Ionicons name="calendar-outline" size={20} color={colors.primary} />
              <ThemedText variant="captionBold" color="textSecondary">
                Game Date & Time
              </ThemedText>
            </View>
            <TouchableOpacity
              style={[
                styles.dateButton,
                {
                  backgroundColor: colors.backgroundSecondary,
                  borderColor: colors.border,
                },
              ]}
              onPress={() => openPicker('date')}
              accessibilityRole="button"
              accessibilityLabel={`Game date: ${formatDate(date)}`}
              testID="game-date-button"
            >
              <Ionicons
                name="calendar"
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
              onPress={() => openPicker('time')}
              accessibilityRole="button"
              accessibilityLabel={`Game time: ${formatTime(date)}`}
              testID="game-time-button"
            >
              <Ionicons name="time" size={20} color={colors.primary} />
              <ThemedText variant="body">{formatTime(date)}</ThemedText>
            </TouchableOpacity>
          </Card>

          <View style={styles.buttonContainer}>
            <Button
              title="Create Game"
              onPress={handleSubmit}
              loading={createGame.isPending}
              disabled={!opponent.trim() || !teamId}
              fullWidth
              size="large"
            />
            <Button
              title="Cancel"
              variant="outline"
              onPress={() => router.back()}
              fullWidth
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <DateTimePickerSheet
        visible={picker !== null}
        mode={picker ?? 'date'}
        value={date}
        title={picker === 'time' ? 'Game time' : 'Game date'}
        onConfirm={(selected) => {
          setDate(selected);
          setPicker(null);
        }}
        onCancel={() => setPicker(null)}
      />
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
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
    alignItems: 'center',
  },
  headerAction: {
    padding: spacing.sm,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  sectionCard: {
    marginBottom: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  teamList: {
    borderRadius: borderRadius.sm,
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
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    marginTop: spacing.sm,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
});
