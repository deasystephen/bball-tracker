/**
 * Create Team screen
 *
 * Self-serve team creation (#442): a coach who sees no league of their own —
 * either none at all, or only auto-provisioned personal containers — gets a
 * name-only form and the backend resolves their personal league + season.
 * The league/season pickers appear only for a coach who actually belongs to a
 * real league, and even then behind a collapsed disclosure whose default is
 * "My teams" (submit without `seasonId`). See `utils/league-scope.ts`.
 */

import React, { useState, useMemo, useEffect } from 'react';
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
import { isUpgradeRequiredError, getApiErrorMessage } from '../../services/api-client';
import { useLeagues } from '../../hooks/useLeagues';
import { useSeasons } from '../../hooks/useSeasons';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { canCreateTeams } from '../../utils/team-permissions';
import { areAllLeaguesPersonal } from '../../utils/league-scope';
import { useAuthUser } from '../../store/auth-store';

/**
 * Sentinel league id for "no league — put it in my own teams". Always offered
 * as the default inside the disclosure: a user who is a member of someone
 * else's team and then switches to COACH sees exactly one league, which is not
 * theirs to write into, so without this there would be no valid choice on the
 * screen.
 */
const MY_TEAMS_OPTION = '__my_teams__';
const MY_TEAMS_LABEL = 'My teams';

export default function CreateTeamScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [leagueId, setLeagueId] = useState(MY_TEAMS_OPTION);
  const [seasonId, setSeasonId] = useState('');
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; seasonId?: string }>({});

  const { data: leagues, isLoading: leaguesLoading } = useLeagues();
  // No league of their own to pick from -> name-only form, no pickers at all.
  const allLeaguesPersonal = areAllLeaguesPersonal(leagues);
  const usesPersonalLeague = allLeaguesPersonal || leagueId === MY_TEAMS_OPTION;

  const { data: seasonsData, isLoading: seasonsLoading } = useSeasons(
    usesPersonalLeague ? undefined : { leagueId, isActive: true }
  );
  const createTeam = useCreateTeam();
  const toast = useToast();
  const user = useAuthUser();
  const canCreate = canCreateTeams(user);

  // Deep links / stale screens can still land here; bounce players out
  // before they fill in a form the API will reject with 403.
  useEffect(() => {
    if (user && !canCreate) {
      toast.showToast(t('teams.createNotAllowed'), 'error');
      router.replace('/(tabs)/teams');
    }
  }, [user, canCreate, router, toast, t]);

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
    const newErrors: { name?: string; seasonId?: string } = {};

    if (!name.trim()) {
      newErrors.name = 'Team name is required';
    }

    // A league is always selected (the "My teams" default), so only a real
    // league needs a season to go with it.
    if (!usesPersonalLeague && !seasonId) {
      newErrors.seasonId = 'Season is required';
    }

    setErrors(newErrors);
    if (newErrors.seasonId) setPickerExpanded(true);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    try {
      // Omitting `seasonId` tells the backend to resolve the caller's personal
      // league + season (#442).
      const team = await createTeam.mutateAsync(
        usesPersonalLeague ? { name: name.trim() } : { name: name.trim(), seasonId }
      );

      toast.showToast('Team created successfully', 'success');
      // Replace so the spent create form isn't left under the detail screen
      // (back should return to the Teams tab, matching games/create).
      router.replace(`/teams/${team.id}`);
    } catch (error) {
      // 402 upgrade_required: FREE-tier team cap (see CLAUDE.md "Usage Metering").
      Alert.alert(
        isUpgradeRequiredError(error) ? 'Upgrade required' : t('common.error'),
        getApiErrorMessage(error, 'Failed to create team')
      );
    }
  };

  if (leaguesLoading) {
    return <LoadingSpinner message="Loading leagues..." fullScreen />;
  }

  const showLeaguePicker = !allLeaguesPersonal;
  const disclosureSummary = usesPersonalLeague
    ? MY_TEAMS_LABEL
    : selectedSeason
      ? `${selectedLeague?.name} · ${selectedSeason.name}`
      : (selectedLeague?.name ?? MY_TEAMS_LABEL);

  const renderRadio = (isSelected: boolean) =>
    isSelected ? (
      <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
    ) : (
      <Ionicons name="ellipse-outline" size={24} color={colors.textTertiary} />
    );

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
            testID="team-name-input"
          />

          {/*
            Nothing but the name for a coach with no league of their own — the
            backend provisions their personal league + season on submit.
          */}
          {showLeaguePicker && (
            <View style={styles.selectionSection}>
              <TouchableOpacity
                onPress={() => setPickerExpanded((expanded) => !expanded)}
                style={[styles.disclosureHeader, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityState={{ expanded: pickerExpanded }}
                accessibilityLabel={`League and season: ${disclosureSummary}`}
                testID="league-season-disclosure"
              >
                <View style={styles.disclosureLabels}>
                  <ThemedText variant="bodyBold">League &amp; season</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {disclosureSummary}
                  </ThemedText>
                </View>
                <Ionicons
                  name={pickerExpanded ? 'chevron-up' : 'chevron-down'}
                  size={20}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>

              {pickerExpanded && (
                <>
                  <View style={styles.selectionSection}>
                    <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                      {t('teams.league')}
                    </ThemedText>
                    <View style={[styles.selectionList, { borderColor: colors.border }]}>
                      <ListItem
                        title={MY_TEAMS_LABEL}
                        subtitle="Just for me — not part of a league"
                        onPress={() => handleLeagueSelect(MY_TEAMS_OPTION)}
                        rightElement={renderRadio(usesPersonalLeague)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: usesPersonalLeague }}
                        accessibilityLabel={MY_TEAMS_LABEL}
                        testID="league-option-my-teams"
                        style={[
                          styles.selectionItem,
                          usesPersonalLeague && { backgroundColor: colors.backgroundSecondary },
                        ]}
                      />
                      {(leagues ?? []).map((league, index) => {
                        const isSelected = leagueId === league.id;
                        const isLast = index === (leagues?.length ?? 0) - 1;
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
                            rightElement={renderRadio(isSelected)}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: isSelected }}
                            testID={`league-option-${league.id}`}
                            style={[
                              styles.selectionItem,
                              isSelected && { backgroundColor: colors.backgroundSecondary },
                              isLast && styles.lastItem,
                            ]}
                          />
                        );
                      })}
                    </View>
                  </View>

                  {/* Season Selection - Only when a real league is selected */}
                  {!usesPersonalLeague && (
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
                                rightElement={renderRadio(isSelected)}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: isSelected }}
                                testID={`season-option-${season.id}`}
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
                        <View
                          style={[
                            styles.noSeasonsContainer,
                            { backgroundColor: colors.backgroundSecondary },
                          ]}
                        >
                          <Ionicons name="calendar-outline" size={32} color={colors.textTertiary} />
                          <ThemedText variant="body" color="textTertiary" style={styles.noSeasonsText}>
                            No active seasons in {selectedLeague?.name}
                          </ThemedText>
                          <ThemedText variant="caption" color="textTertiary">
                            Pick &quot;{MY_TEAMS_LABEL}&quot; instead — you can move the team later.
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
                </>
              )}
            </View>
          )}

          {/* Summary when a real league + season are selected */}
          {!usesPersonalLeague && selectedLeague && selectedSeason && (
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
              disabled={!name.trim() || (!usesPersonalLeague && !seasonId)}
              fullWidth
              // Tapped by id in Maestro: the button label is `common.create`
              // ("Create") while the screen header is `teams.create`
              // ("Create Team"), so a text match on "Create" is ambiguous.
              testID="create-team-submit"
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
  disclosureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    minHeight: 44,
  },
  disclosureLabels: {
    flex: 1,
    gap: spacing.xs,
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
