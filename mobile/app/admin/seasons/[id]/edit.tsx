/**
 * Edit Season screen (#614): name, start and end date, active flag, saved
 * through `PATCH /seasons/:id` with only the fields that changed.
 *
 * Validation mirrors `updateSeasonSchema` (name 1–100 characters, dates
 * nullable) plus the service's range check (start not after end). Clearing a
 * date sends `null`, which the server reads as "clear", never "keep".
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Switch,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
  ErrorState,
  SeasonDateFields,
} from '../../../../components';
import { useToast } from '../../../../components/Toast';
import { useSeason, useUpdateSeason, Season, UpdateSeasonInput } from '../../../../hooks/useSeasons';
import { useTheme } from '../../../../hooks/useTheme';
import { useAccessGuard } from '../../../../hooks/useAccessGuard';
import { useGoBack } from '../../../../hooks/useGoBack';
import { useAuthUser } from '../../../../store/auth-store';
import { canManageLeague } from '../../../../utils/team-permissions';
import { getApiErrorMessage } from '../../../../services/api-client';
import { useTranslation } from '../../../../i18n';
import { spacing } from '../../../../theme';
import { getHorizontalPadding } from '../../../../utils/responsive';

const NAME_MAX_LENGTH = 100;

const toDate = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);
const sameDay = (a: Date | null, b: Date | null): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** The PATCH body for a form state, holding only what differs from the season. */
export function buildSeasonPatch(
  season: Season,
  form: { name: string; startDate: Date | null; endDate: Date | null; isActive: boolean }
): UpdateSeasonInput {
  const patch: UpdateSeasonInput = {};
  const name = form.name.trim();
  if (name !== season.name) patch.name = name;
  if (!sameDay(form.startDate, toDate(season.startDate))) {
    patch.startDate = form.startDate ? form.startDate.toISOString() : null;
  }
  if (!sameDay(form.endDate, toDate(season.endDate))) {
    patch.endDate = form.endDate ? form.endDate.toISOString() : null;
  }
  if (form.isActive !== season.isActive) patch.isActive = form.isActive;
  return patch;
}

export default function EditSeasonScreen() {
  const goBack = useGoBack('/admin');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { data: season, isLoading, error, refetch } = useSeason(id);

  // Same rule as the detail screen: ADMIN or admin of the season's league.
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user && !!season,
    canManageLeague(user, season?.leagueId),
    t('seasons.manageNotAllowed'),
    { fallback: '/admin' }
  );

  if (isLoading || (season && !allowed)) {
    return <LoadingSpinner message={t('seasons.loading')} fullScreen />;
  }

  if (error || !season) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('seasons.notFound')}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }

  // Keyed by season id so the form re-seeds if a different season loads.
  return <EditSeasonForm key={season.id} season={season} />;
}

function EditSeasonForm({ season }: { season: Season }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const updateSeason = useUpdateSeason();

  const [name, setName] = useState(season.name);
  const [startDate, setStartDate] = useState<Date | null>(toDate(season.startDate));
  const [endDate, setEndDate] = useState<Date | null>(toDate(season.endDate));
  const [isActive, setIsActive] = useState(season.isActive);
  const [errors, setErrors] = useState<{ name?: string; dates?: string }>({});

  const validate = (): boolean => {
    const next: { name?: string; dates?: string } = {};
    const trimmed = name.trim();
    if (!trimmed) {
      next.name = t('seasons.nameRequired');
    } else if (trimmed.length > NAME_MAX_LENGTH) {
      next.name = t('seasons.nameTooLong');
    }
    if (startDate && endDate && startDate > endDate) {
      next.dates = t('seasons.startAfterEnd');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    const patch = buildSeasonPatch(season, { name, startDate, endDate, isActive });
    if (Object.keys(patch).length === 0) {
      router.back();
      return;
    }

    try {
      await updateSeason.mutateAsync({ seasonId: season.id, data: patch });
      toast.showToast(t('seasons.updateSuccess'), 'success');
      router.back();
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('seasons.updateFailed')), 'error');
    }
  };

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
          <ThemedText variant="h2">{t('seasons.editTitle')}</ThemedText>
          <ThemedText variant="caption" color="textSecondary" numberOfLines={1}>
            {season.name}
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
            label={t('seasons.name')}
            placeholder={t('seasons.namePlaceholder')}
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            maxLength={NAME_MAX_LENGTH}
            testID="season-name-input"
          />

          <SeasonDateFields
            startDate={startDate}
            endDate={endDate}
            onChangeStart={setStartDate}
            onChangeEnd={setEndDate}
            error={errors.dates}
          />

          <View
            style={[
              styles.switchRow,
              { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
            ]}
          >
            <View style={styles.switchText}>
              <ThemedText variant="body">{t('seasons.activeToggle')}</ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {t('seasons.activeHelp')}
              </ThemedText>
            </View>
            <Switch
              value={isActive}
              onValueChange={setIsActive}
              trackColor={{ true: colors.primary }}
              accessibilityLabel={t('seasons.activeToggle')}
              testID="season-active-switch"
            />
          </View>

          <View style={styles.buttonContainer}>
            <Button
              title={t('common.save')}
              onPress={handleSubmit}
              loading={updateSeason.isPending}
              disabled={!name.trim()}
              fullWidth
              testID="season-save-button"
            />
            <Button
              title={t('common.cancel')}
              variant="outline"
              onPress={() => router.back()}
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
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
});
