/**
 * Start next season (#461): carry a team's roster and staff into a new
 * team-season row on the same lineage. Last season's row, games and stats stay
 * as they are; the player career view still reads them.
 *
 * The season is picked from the team's league's ACTIVE seasons that may
 * follow the team's own (`GET /seasons?leagueId=`, caller-scoped, filtered by
 * `isActive` and `utils/season-order.ts#isSeasonAfter`) and sent as
 * `seasonId`. Every refusal the API can answer shows translated copy. Only the lineage's latest team-season may
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
import { isSeasonAfter } from '../../../utils/season-order';
import { useGoBack } from '../../../hooks/useGoBack';
import type { NormalizedApiError } from '../../../services/api-client';
import { apiErrorCode } from '../../../utils/api-error-code';
import { BackButton } from '../../../components/BackButton';

/**
 * Translated copy for every refusal `POST /teams/:id/rollover` can answer
 * (#461), by the body's `code`; a 403 carries none. Anything else (network,
 * 5xx) keeps the generic failure line.
 */
const ROLLOVER_ERROR_KEYS: Record<string, string> = {
  not_latest_season: 'teams.nextSeason.notLatest',
  team_season_exists: 'teams.nextSeason.teamSeasonExists',
  season_not_after_source: 'teams.nextSeason.seasonNotAfter',
  season_archived: 'teams.nextSeason.seasonArchived',
};

function rolloverErrorMessage(err: unknown, t: (key: string) => string): string {
  const code = apiErrorCode(err);
  if (code && ROLLOVER_ERROR_KEYS[code]) return t(ROLLOVER_ERROR_KEYS[code]);
  if ((err as NormalizedApiError | undefined)?.apiError?.status === 403) return t('teams.nextSeason.forbidden');
  return t('teams.nextSeason.failed');
}
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
  // Every season of the league, so the form knows which names are taken but
  // hidden (archived, or not after this one); only some are offered.
  const seasons = useSeasons({ leagueId, limit: SEASON_PAGE }, { enabled: !!leagueId });

  // Owned here, not by the form, so the guard below can see it.
  const rollover = useRolloverTeam();

  // The backend gates rollover on `canManageStaff` (head coach, league admin,
  // system admin); the screen is deep-linkable, so it guards itself too.
  // Only the lineage's latest team-season may start the next one (#461);
  // `isLatestInLineage` is present only for a staff manager, so absent means
  // "not allowed" and `false` means "not the latest".
  const user = useAuthUser();
  const isLatest = team?.isLatestInLineage === true;
  const deniedMessage =
    team?.isLatestInLineage === false ? t('teams.nextSeason.notLatest') : t('teams.nextSeason.notAllowed');
  // Once the rollover is in flight or done, the guard no longer reacts: the
  // success path refetches this (source) team, which is then no longer the
  // latest, and the screen is already replacing itself with the new one. A
  // late flip must not toast an error or pop the stack.
  const rolledOver = rollover.isPending || rollover.isSuccess;
  const allowed = useAccessGuard(
    !!user && !!team,
    rolledOver || (isLatest && canManageStaff(team, user?.id, user?.role, user?.leagueAdminOf)),
    deniedMessage,
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

  // Offered: active seasons other than the team's own that may follow it
  // (`isSeasonAfter`, the API's rule; the API answers 409 `season_archived`
  // or 400 `season_not_after_source` otherwise). The rest are hidden but their
  // names still matter for the default choice.
  const all = (seasons.data?.seasons ?? []).filter((season) => season.id !== team.seasonId);
  const offered = all.filter((season) => season.isActive && !!team.season && isSeasonAfter(season, team.season));
  const hidden = all.filter((season) => !offered.includes(season));

  // Keyed by team id so the form re-seeds if a different team loads.
  return (
    <NextSeasonForm
      key={team.id}
      team={team}
      seasons={offered}
      hiddenSeasons={hidden}
      canCreateSeason={seasons.data?.canCreate === true}
      rollover={rollover}
    />
  );
}

interface NextSeasonFormProps {
  team: Team;
  /** Seasons the coach may pick. */
  seasons: { id: string; name: string }[];
  /** The league's other seasons (archived, or not after this one): never offered. */
  hiddenSeasons: { id: string; name: string }[];
  canCreateSeason: boolean;
  rollover: ReturnType<typeof useRolloverTeam>;
}

function NextSeasonForm({ team, seasons, hiddenSeasons, canCreateSeason, rollover }: NextSeasonFormProps) {
  const router = useRouter();
  const goBack = useGoBack(`/teams/${team.id}`);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const currentSeason = team.season?.name ?? '';
  const suggestion = suggestNextSeasonName(currentSeason);

  // Start on the season the suggestion names when it is offered. When the
  // suggestion names a season the league has but does not offer (archived,
  // or not after this one), never default to "New season" with that name
  // (the API would refuse it): start on the first offered season, or on
  // nothing. Otherwise "New season" when the caller may create one.
  const initialChoice = useMemo(() => {
    const wanted = suggestion.trim().toLowerCase();
    const matches = (season: { name: string }): boolean => !!wanted && season.name.trim().toLowerCase() === wanted;
    const offered = seasons.find(matches);
    if (offered) return offered.id;
    if (hiddenSeasons.some(matches) || (team.season && matches(team.season))) {
      return seasons[0]?.id ?? null;
    }
    return canCreateSeason ? NEW_SEASON : null;
  }, [seasons, hiddenSeasons, suggestion, canCreateSeason, team.season]);

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
      // The server's own message is English: every answer this screen can get
      // from the rollover has translated copy instead.
      Alert.alert(t('common.error'), rolloverErrorMessage(err, t));
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
              disabled={rollover.isPending || options.length === 0 || choice === null}
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
