/**
 * Start next season (#461): carry a team's roster and staff into a new
 * team-season row on the same lineage. Last season's row, games and stats stay
 * as they are; the player career view still reads them.
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Input, Button, LoadingSpinner, ErrorState } from '../../../components';
import { useToast } from '../../../components/Toast';
import { useTeam, useRolloverTeam, canManageStaff, type Team } from '../../../hooks/useTeams';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { suggestNextSeasonName } from '../../../utils/season-name';
import { useGoBack } from '../../../hooks/useGoBack';
import { BackButton } from '../../../components/BackButton';

export default function NextSeasonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = useGoBack(`/teams/${id}`);
  const { t } = useTranslation();
  const { data: team, isLoading, error, refetch } = useTeam(id);

  // The backend gates rollover on `canManageStaff` (head coach, league admin,
  // system admin); the screen is deep-linkable, so it guards itself too.
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user && !!team,
    canManageStaff(team, user?.id, user?.role, user?.leagueAdminOf),
    t('teams.nextSeason.notAllowed'),
    { fallback: `/teams/${id}` }
  );

  if (isLoading || (team && !allowed)) {
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

  // Keyed by team id so the form re-seeds if a different team loads.
  return <NextSeasonForm key={team.id} team={team} />;
}

function NextSeasonForm({ team }: { team: Team }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const rollover = useRolloverTeam();

  const currentSeason = team.season?.name ?? '';
  const [seasonName, setSeasonName] = useState(() => suggestNextSeasonName(currentSeason));
  const [name, setName] = useState(team.name);
  // Brackets move with the kids (U12 becomes U13): prefilled, editable, and
  // an emptied field clears it on the new season.
  const [ageGroup, setAgeGroup] = useState(team.ageGroup ?? '');
  const [errors, setErrors] = useState<{ seasonName?: string; name?: string }>({});

  const handleSubmit = async () => {
    const next: { seasonName?: string; name?: string } = {};
    if (!seasonName.trim()) next.seasonName = t('teams.nextSeason.seasonNameRequired');
    if (!name.trim()) next.name = t('teams.nameRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      const { team: nextTeam, created } = await rollover.mutateAsync({
        teamId: team.id,
        data: { seasonName: seasonName.trim(), name: name.trim(), ageGroup: ageGroup.trim() || null },
      });
      const season = nextTeam.season?.name ?? seasonName.trim();
      toast.showToast(
        created ? t('teams.nextSeason.success', { season }) : t('teams.nextSeason.alreadyExists', { season }),
        created ? 'success' : 'info'
      );
      router.replace(`/teams/${nextTeam.id}`);
    } catch (err) {
      Alert.alert(t('common.error'), err instanceof Error ? err.message : t('teams.nextSeason.failed'));
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
        <BackButton onPress={() => router.back()} style={styles.backButton} />
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

          <Input
            label={t('teams.nextSeason.seasonName')}
            placeholder={t('teams.nextSeason.seasonNamePlaceholder')}
            value={seasonName}
            onChangeText={setSeasonName}
            error={errors.seasonName}
            maxLength={100}
            testID="next-season-name-input"
          />

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
              disabled={rollover.isPending}
              fullWidth
              testID="next-season-submit"
            />
            <Button title={t('common.cancel')} variant="outline" onPress={() => router.back()} fullWidth />
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
  buttonContainer: { marginTop: spacing.xl, gap: spacing.md },
});
