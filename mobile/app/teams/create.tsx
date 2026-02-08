/**
 * Create Team screen
 */

import React, { useState, useMemo } from 'react';
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
import { ThemedView, ThemedText, Input, Button, LoadingSpinner, ListItem } from '../../components';
import { useToast } from '../../components/Toast';
import { useCreateTeam } from '../../hooks/useTeams';
import { useLeagues } from '../../hooks/useLeagues';
import { useSeasons } from '../../hooks/useSeasons';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { useAuthStore } from '../../store/auth-store';
import { Ionicons } from '@expo/vector-icons';

export default function CreateTeamScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const { user } = useAuthStore();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [leagueId, setLeagueId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [errors, setErrors] = useState<{ name?: string; leagueId?: string; seasonId?: string }>({});

  const { data: leagues, isLoading: leaguesLoading } = useLeagues();
  const { data: seasonsData, isLoading: seasonsLoading } = useSeasons(
    leagueId ? { leagueId, isActive: true } : undefined
  );
  const createTeam = useCreateTeam();
  const toast = useToast();

  // Get seasons for the selected league
  const seasons = useMemo(() => {
    return seasonsData?.seasons ?? [];
  }, [seasonsData]);

  // Get selected league info
  const selectedLeague = useMemo(() => {
    return leagues?.find((l) => l.id === leagueId);
  }, [leagues, leagueId]);

  // Get selected season info
  const selectedSeason = useMemo(() => {
    return seasons.find((s) => s.id === seasonId);
  }, [seasons, seasonId]);

  // Reset season when league changes
  const handleLeagueSelect = (id: string) => {
    setLeagueId(id);
    setSeasonId(''); // Reset season when league changes
  };

  const validate = (): boolean => {
    const newErrors: { name?: string; leagueId?: string; seasonId?: string } = {};

    if (!name.trim()) {
      newErrors.name = 'Team name is required';
    }

    if (!leagueId) {
      newErrors.leagueId = 'League is required';
    }

    if (!seasonId) {
      newErrors.seasonId = 'Season is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    try {
      const team = await createTeam.mutateAsync({
        name: name.trim(),
        seasonId,
      });

      toast.showToast('Team created successfully', 'success');
      router.push(`/teams/${team.id}`);
    } catch (error) {
      Alert.alert(
        t('common.error'),
        error instanceof Error ? error.message : 'Failed to create team'
      );
    }
  };

  if (leaguesLoading) {
    return <LoadingSpinner message="Loading leagues..." fullScreen />;
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
            {t('teams.create')}
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
            label={t('teams.name')}
            placeholder="Enter team name"
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            autoFocus
          />

          {/* League Selection */}
          <View style={styles.selectionSection}>
            <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
              {t('teams.league')}
            </ThemedText>
            {leagues && leagues.length > 0 ? (
              <View style={[styles.selectionList, { borderColor: colors.border }]}>
                {leagues.map((league, index) => {
                  const isSelected = leagueId === league.id;
                  const isLast = index === leagues.length - 1;
                  return (
                    <ListItem
                      key={league.id}
                      title={league.name}
                      subtitle={
                        league._count?.seasons
                          ? `${league._count.seasons} season${league._count.seasons === 1 ? '' : 's'}`
                          : 'No seasons'
                      }
                      onPress={() => handleLeagueSelect(league.id)}
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
                        styles.selectionItem,
                        isSelected && { backgroundColor: colors.backgroundSecondary },
                        isLast && styles.lastItem,
                      ]}
                    />
                  );
                })}
              </View>
            ) : (
              <ThemedText variant="caption" color="textTertiary" style={styles.noItems}>
                No leagues available. Create a league first.
              </ThemedText>
            )}
            {errors.leagueId && (
              <ThemedText variant="footnote" color="error" style={styles.errorText}>
                {errors.leagueId}
              </ThemedText>
            )}
          </View>

          {/* Season Selection - Only show when league is selected */}
          {leagueId && (
            <View style={styles.selectionSection}>
              <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                Season
              </ThemedText>
              {seasonsLoading ? (
                <View style={styles.loadingContainer}>
                  <LoadingSpinner message="Loading seasons..." />
                </View>
              ) : seasons.length > 0 ? (
                <View style={[styles.selectionList, { borderColor: colors.border }]}>
                  {seasons.map((season, index) => {
                    const isSelected = seasonId === season.id;
                    const isLast = index === seasons.length - 1;
                    return (
                      <ListItem
                        key={season.id}
                        title={season.name}
                        subtitle={
                          season._count?.teams
                            ? `${season._count.teams} team${season._count.teams === 1 ? '' : 's'}`
                            : 'No teams yet'
                        }
                        onPress={() => setSeasonId(season.id)}
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
                          styles.selectionItem,
                          isSelected && { backgroundColor: colors.backgroundSecondary },
                          isLast && styles.lastItem,
                        ]}
                      />
                    );
                  })}
                </View>
              ) : (
                <View style={[styles.noSeasonsContainer, { backgroundColor: colors.backgroundSecondary }]}>
                  <Ionicons name="calendar-outline" size={32} color={colors.textTertiary} />
                  <ThemedText variant="body" color="textTertiary" style={styles.noSeasonsText}>
                    No active seasons in {selectedLeague?.name}
                  </ThemedText>
                  <ThemedText variant="caption" color="textTertiary">
                    Ask a league admin to create a season first.
                  </ThemedText>
                </View>
              )}
              {errors.seasonId && (
                <ThemedText variant="footnote" color="error" style={styles.errorText}>
                  {errors.seasonId}
                </ThemedText>
              )}
            </View>
          )}

          {/* Summary when both are selected */}
          {leagueId && seasonId && selectedLeague && selectedSeason && (
            <View style={[styles.summaryCard, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
              <ThemedText variant="caption" color="textSecondary">
                Creating team in:
              </ThemedText>
              <ThemedText variant="bodyBold">
                {selectedLeague.name} - {selectedSeason.name}
              </ThemedText>
            </View>
          )}

          <View style={styles.buttonContainer}>
            <Button
              title={t('common.create')}
              onPress={handleSubmit}
              loading={createTeam.isPending}
              disabled={!name.trim() || !leagueId || !seasonId}
              fullWidth
            />
            <Button
              title={t('common.cancel')}
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
  selectionSection: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  selectionList: {
    marginTop: spacing.sm,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    overflow: 'hidden',
  },
  selectionItem: {
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  lastItem: {
    borderBottomWidth: 0,
  },
  noItems: {
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  loadingContainer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  noSeasonsContainer: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    gap: spacing.sm,
  },
  noSeasonsText: {
    textAlign: 'center',
  },
  summaryCard: {
    padding: spacing.md,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  errorText: {
    marginTop: spacing.xs,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
