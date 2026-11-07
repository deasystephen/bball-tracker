/**
 * Start next season (#461): carry a team's roster and staff into a new
 * team-season row on the same lineage. Last season's row, games and stats stay
 * as they are; the player career view still reads them.
 *
 * The season is picked from the team's league's ACTIVE seasons
 * (`GET /seasons?leagueId=&isActive=true`, caller-scoped; never the team's own
 * season) and sent as `seasonId`. Only the lineage's latest team-season may
 * start the next one (`isLatestInLineage`). "New season" with a free-text name is
 * offered only when that list says the caller may create one (`canCreate`:
 * league admin, which a personal-league owner is); a club coach picks a season
 * the club already made. The API stays the authority (403 / 404).
 */

import React, { useMemo, useState } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ThemedView, ThemedText, Input, Button, LoadingSpinner, ErrorState, ListItem } from '../../../components';
import { useToast } from '../../../components/Toast';
import { useTeam, useRolloverTeam, canManageStaff, type Team, type RolloverTeamInput } from '../../../hooks/useTeams';
import { useSeasons } from '../../../hooks/useSeasons';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { suggestNextSeasonName } from '../../../utils/season-name';
import { useGoBack } from '../../../hooks/useGoBack';
import type { NormalizedApiError } from '../../../services/api-client';
import { BackButton } from '../../../components/BackButton';

/** 409 code for a season name that matches an archived season of the league (#461). */
const SEASON_ARCHIVED_CODE = 'season_archived';
/** The picker's "new season" choice; every other value is a season id. */
const NEW_SEASON = 'new';
/** The API's page ceiling; a league with more seasons than this is not a real case. */
const SEASON_PAGE = 100;

export default function NextSeasonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = useGoBack(`/teams/${id}`);
  const { t } = useTranslation();
  const { data: team, isLoading, error, refetch } = useTeam(id);
  const leagueId = team?.season?.league?.id;
  // Active seasons only: an archived season is not one to start.
  const seasons = useSeasons({ leagueId, isActive: true, limit: SEASON_PAGE }, { enabled: !!leagueId });

  // The backend gates rollover on `canManageStaff` (head coach, league admin,
  // system admin); the screen is deep-linkable, so it guards itself too.
  const user = useAuthUser();
  // Only the lineage's latest team-season may start the next one (#461).
  const isLatest = team?.isLatestInLineage === true;
  const allowed = useAccessGuard(
    !!user && !!team,
    isLatest && canManageStaff(team, user?.id, user?.role, user?.leagueAdminOf),
    t(isLatest ? 'teams.nextSeason.notAllowed' : 'teams.nextSeason.notLatest'),
    { fallback: `/teams/${id}` }
  );

  if (isLoading || (team && !allowed) || (leagueId && seasons.isLoading)) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (error || !team) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('teams.notFound')}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }

  if (seasons.error) {
    return (
      <ErrorState
        message={seasons.error instanceof Error ? seasons.error.message : t('teams.nextSeason.seasonsFailed')}
        onRetry={seasons.refetch}
        onBack={goBack}
      />
    );
  }

  // Keyed by team id so the form re-seeds if a different team loads.
  return (
    <NextSeasonForm
      key={team.id}
      team={team}
      seasons={(seasons.data?.seasons ?? []).filter((season) => season.id !== team.seasonId)}
      canCreateSeason={seasons.data?.canCreate === true}
    />
  );
}

interface NextSeasonFormProps {
  team: Team;
  seasons: { id: string; name: string }[];
  canCreateSeason: boolean;
}

function NextSeasonForm({ team, seasons, canCreateSeason }: NextSeasonFormProps) {
  const router = useRouter();
  const goBack = useGoBack(`/teams/${team.id}`);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const rollover = useRolloverTeam();

  const currentSeason = team.season?.name ?? '';
  const suggestion = suggestNextSeasonName(currentSeason);

  // Start on the season the suggestion names when the league has it, else on
  // "new season" when the caller may create one, else on nothing.
  const initialChoice = useMemo(() => {
    const wanted = suggestion.trim().toLowerCase();
    const match = wanted ? seasons.find((season) => season.name.trim().toLowerCase() === wanted) : undefined;
    if (match) return match.id;
    return canCreateSeason ? NEW_SEASON : null;
  }, [seasons, suggestion, canCreateSeason]);

  const [choice, setChoice] = useState<string | null>(initialChoice);
  const [newSeasonName, setNewSeasonName] = useState(suggestion);
  const [name, setName] = useState(team.name);
  // Brackets move with the kids (U12 becomes U13): prefilled, editable, and
  // an emptied field clears it on the new season.
  const [ageGroup, setAgeGroup] = useState(team.ageGroup ?? '');
  const [errors, setErrors] = useState<{ season?: string; name?: string }>({});

  const options = [
    ...seasons.map((season) => ({ key: season.id, title: season.name })),
    ...(canCreateSeason ? [{ key: NEW_SEASON, title: t('teams.nextSeason.newSeason') }] : []),
  ];

  const handleSubmit = async () => {
    const next: { season?: string; name?: string } = {};
    if (!choice) next.season = t('teams.nextSeason.seasonRequired');
    if (choice === NEW_SEASON && !newSeasonName.trim()) next.season = t('teams.nextSeason.seasonNameRequired');
    if (!name.trim()) next.name = t('teams.nameRequired');
    setErrors(next);
    if (Object.keys(next).length > 0 || !choice) return;

    const target: Pick<RolloverTeamInput, 'seasonId' | 'seasonName'> =
      choice === NEW_SEASON ? { seasonName: newSeasonName.trim() } : { seasonId: choice };

    try {
      const { team: nextTeam, created } = await rollover.mutateAsync({
        teamId: team.id,
        data: { ...target, name: name.trim(), ageGroup: ageGroup.trim() || null },
      });
      const season = nextTeam.season?.name ?? newSeasonName.trim();
      toast.showToast(
        created ? t('teams.nextSeason.success', { season }) : t('teams.nextSeason.alreadyExists', { season }),
        created ? 'success' : 'info'
      );
      router.replace(`/teams/${nextTeam.id}`);
    } catch (err) {
      // The server's own message is English; a code the form knows gets its
      // translated copy instead.
      const code = (err as NormalizedApiError).apiError?.code;
      const message =
        code === SEASON_ARCHIVED_CODE
          ? t('teams.nextSeason.seasonArchived')
          : err instanceof Error
            ? err.message
            : t('teams.nextSeason.failed');
      Alert.alert(t('common.error'), message);
    }
  };

  return (
    <ThemedView variant="background" style={styles.container}>
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
        <BackButton onPress={goBack} style={styles.backButton} />
        <ThemedText variant="h2" heading style={styles.headerTitle}>
          {t('teams.nextSeason.title')}
        </ThemedText>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardView}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { padding, paddingBottom: insets.bottom + spacing.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText variant="body" color="textSecondary" style={styles.intro}>
            {currentSeason
              ? t('teams.nextSeason.intro', { season: currentSeason })
              : t('teams.nextSeason.introNoSeason')}
          </ThemedText>

          <View style={styles.section}>
            <ThemedText variant="captionBold" color="textSecondary" heading style={styles.label}>
              {t('teams.nextSeason.season')}
            </ThemedText>
            {options.length > 0 ? (
              <View style={[styles.selectionList, { borderColor: colors.border }]}>
                {options.map((option) => {
                  const isSelected = choice === option.key;
                  return (
                    <ListItem
                      key={option.key}
                      title={option.title}
                      onPress={() => setChoice(option.key)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      testID={`next-season-option-${option.key}`}
                      rightElement={
                        <Ionicons
                          name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                          size={24}
                          color={isSelected ? colors.primary : colors.textTertiary}
                        />
                      }
                      style={[styles.selectionItem, isSelected && { backgroundColor: colors.backgroundSecondary }]}
                    />
                  );
                })}
              </View>
            ) : (
              <ThemedText variant="body" color="textTertiary" testID="next-season-none">
                {t('teams.nextSeason.noSeasons')}
              </ThemedText>
            )}
            {choice === NEW_SEASON && (
              <View style={styles.newSeasonInput}>
                <Input
                  label={t('teams.nextSeason.seasonName')}
                  placeholder={t('teams.nextSeason.seasonNamePlaceholder')}
                  value={newSeasonName}
                  onChangeText={setNewSeasonName}
                  maxLength={100}
                  testID="next-season-name-input"
                />
              </View>
            )}
            {errors.season && (
              <ThemedText variant="footnote" color="error" style={styles.errorText}>
                {errors.season}
              </ThemedText>
            )}
          </View>

          <Input
            label={t('teams.name')}
            placeholder={t('teams.namePlaceholder')}
            value={name}
            onChangeText={setName}
            error={errors.name}
            maxLength={100}
            autoCapitalize="words"
            testID="next-season-team-name-input"
          />

          <Input
            label={t('teams.ageGroup')}
            placeholder={t('teams.ageGroupPlaceholder')}
            value={ageGroup}
            onChangeText={setAgeGroup}
            maxLength={20}
            autoCapitalize="characters"
            testID="next-season-age-group-input"
          />

          <View style={styles.buttonContainer}>
            <Button
              title={t('teams.nextSeason.submit')}
              onPress={handleSubmit}
              loading={rollover.isPending}
              disabled={rollover.isPending || options.length === 0}
              fullWidth
              testID="next-season-submit"
            />
            <Button title={t('common.cancel')} variant="outline" onPress={goBack} fullWidth />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { marginRight: spacing.sm, marginLeft: -spacing.xs },
  headerTitle: { flex: 1 },
  keyboardView: { flex: 1 },
  scrollContent: { paddingTop: spacing.lg },
  intro: { marginBottom: spacing.lg },
  section: { marginBottom: spacing.lg },
  label: { marginBottom: spacing.sm },
  selectionList: {
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    overflow: 'hidden',
  },
  selectionItem: { marginBottom: 0, borderBottomWidth: 0 },
  newSeasonInput: { marginTop: spacing.md },
  errorText: { marginTop: spacing.xs },
  buttonContainer: { marginTop: spacing.xl, gap: spacing.md },
});
