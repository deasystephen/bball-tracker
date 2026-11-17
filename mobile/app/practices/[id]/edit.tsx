/**
 * Edit a practice (#33), in one of two scopes chosen from the detail's ⋯ menu:
 *
 * - `?scope=one` ("Edit this practice"): type, title, location, notes, date,
 *   time and duration of this session only. On a series occurrence the API
 *   marks it an exception, and a later "edit all future" leaves the fields
 *   changed here alone.
 * - `?scope=series` ("Edit all future practices"): type, title, location and
 *   notes, applied by the API to the series and to every upcoming practice
 *   that was not changed on its own. Dates and times cannot change for a
 *   series (cancel it and create a new one); the screen says so.
 *
 * Only changed fields are sent. A new start is an instant and is sent without
 * a zone, so the session keeps the zone it was scheduled in; the pickers show
 * the device's wall time, and the screen names the device zone when it is
 * not the session's.
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, Keyboard, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Button, Card, LoadingSpinner, ErrorState } from '../../../components';
import { BackButton } from '../../../components/BackButton';
import { DateTimePickerSheet } from '../../../components/DateTimePickerSheet';
import { useToast } from '../../../components/Toast';
import {
  PracticeDetailsFields,
  PickerRow,
  DurationPills,
  type PracticeDetailsValue,
} from '../../../components/practice/PracticeFormFields';
import {
  usePractice,
  usePracticeSeries,
  useUpdatePractice,
  useUpdatePracticeSeries,
} from '../../../hooks/usePractices';
import { useTeam, hasTeamPermission } from '../../../hooks/useTeams';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useGoBack } from '../../../hooks/useGoBack';
import { useTheme } from '../../../hooks/useTheme';
import { useAuthUser } from '../../../store/auth-store';
import { getApiErrorMessage } from '../../../services/api-client';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { MIN_TOUCH_TARGET } from '../../../utils/touch-target';
import { deviceTimeZone, formatClockTime, formatLongDate, isOtherTimeZone } from '../../../utils/format-date';
import { combineDateAndTime } from '../../../utils/practice-schedule';
import type { PracticeDetailsInput, UpdatePracticeInput } from '../../../types/practice';

function detailsOf(source: {
  type: PracticeDetailsValue['type'];
  title: string | null;
  location: string | null;
  notes: string | null;
}): PracticeDetailsValue {
  return {
    type: source.type,
    title: source.title ?? '',
    location: source.location ?? '',
    notes: source.notes ?? '',
  };
}

/** The descriptive fields that differ from `before`; an emptied field is sent as `''` (clears it). */
function changedDetails(before: PracticeDetailsValue, after: PracticeDetailsValue): PracticeDetailsInput {
  const patch: PracticeDetailsInput = {};
  if (after.type !== before.type) patch.type = after.type;
  for (const key of ['title', 'location', 'notes'] as const) {
    if (after[key].trim() !== before[key].trim()) patch[key] = after[key].trim();
  }
  return patch;
}

export default function EditPracticeScreen() {
  const { id, scope } = useLocalSearchParams<{ id: string; scope?: string }>();
  const seriesScope = scope === 'series';
  const goBack = useGoBack(`/practices/${id}`);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const user = useAuthUser();

  const { data: practice, isLoading, error, refetch } = usePractice(id);
  const seriesQuery = usePracticeSeries(seriesScope ? practice?.seriesId : null);
  const { data: team, isLoading: teamLoading } = useTeam(practice?.teamId ?? '');
  const updateOne = useUpdatePractice();
  const updateSeries = useUpdatePracticeSeries();
  const saving = updateOne.isPending || updateSeries.isPending;

  const canManageTeam = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);
  const allowed = useAccessGuard(!!practice && !teamLoading && !!user, canManageTeam, t('practices.notAllowed'), {
    fallback: `/practices/${id}`,
  });

  // The form shows the session ("this one") or the series ("all future") as
  // loaded, with the user's edits on top; only edited fields are sent.
  const source = seriesScope ? seriesQuery.data : practice;
  const [edits, setEdits] = useState<Partial<PracticeDetailsValue>>({});
  const [startEdit, setStartEdit] = useState<Date | null>(null);
  const [durationEdit, setDurationEdit] = useState<number | null>(null);
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);

  const loadError = error || (seriesScope && seriesQuery.error);
  if (loadError && !practice) {
    return (
      <ErrorState
        message={loadError instanceof Error ? loadError.message : t('practices.notFound')}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }
  if (seriesScope && seriesQuery.error) {
    return (
      <ErrorState
        message={seriesQuery.error instanceof Error ? seriesQuery.error.message : t('practices.notFound')}
        onRetry={() => seriesQuery.refetch()}
        onBack={goBack}
      />
    );
  }
  if (isLoading || !allowed || !practice || !source) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const initial = detailsOf(source);
  const details: PracticeDetailsValue = { ...initial, ...edits };
  const start = startEdit ?? new Date(practice.startsAt);
  const duration = durationEdit ?? practice.durationMinutes;

  const handleSave = async () => {
    const patch = changedDetails(initial, details);
    try {
      if (seriesScope) {
        if (!practice.seriesId) return;
        if (Object.keys(patch).length > 0) {
          const result = await updateSeries.mutateAsync({ seriesId: practice.seriesId, data: patch });
          toast.showToast(t('practices.seriesUpdatedToast', { count: result.updatedSessions ?? 0 }), 'success');
        }
      } else {
        const data: UpdatePracticeInput = { ...patch };
        if (start.getTime() !== new Date(practice.startsAt).getTime()) data.startsAt = start.toISOString();
        if (duration !== practice.durationMinutes) data.durationMinutes = duration;
        if (Object.keys(data).length > 0) {
          await updateOne.mutateAsync({ practiceId: practice.id, data });
          toast.showToast(t('practices.updatedToast'), 'success');
        }
      }
      goBack();
    } catch (err) {
      Alert.alert(t('common.error'), getApiErrorMessage(err, t('practices.errors.updateFailed')));
    }
  };

  const device = deviceTimeZone();
  const otherZone = isOtherTimeZone(practice.timezone);

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.topHeader,
          { paddingTop: insets.top + spacing.md, paddingHorizontal: padding, borderBottomColor: colors.border },
        ]}
      >
        <BackButton onPress={goBack} style={styles.backButton} icon="close" />
        <View style={styles.headerContent}>
          <ThemedText variant="h3" heading numberOfLines={1}>
            {seriesScope ? t('practices.menu.editSeries') : practice.seriesId ? t('practices.menu.editOne') : t('practices.menu.edit')}
          </ThemedText>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { padding, paddingBottom: insets.bottom + spacing.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText variant="caption" color="textSecondary" style={styles.explain} testID="practice-edit-scope">
            {seriesScope
              ? t('practices.editSeriesExplain')
              : practice.seriesId
                ? t('practices.editOneExplain')
                : t('practices.editStandaloneExplain')}
          </ThemedText>

          <Card variant="default" style={styles.section}>
            <PracticeDetailsFields value={details} onChange={(patch) => setEdits((current) => ({ ...current, ...patch }))} />
          </Card>

          {!seriesScope ? (
            <Card variant="default" style={styles.section}>
              <PickerRow
                icon="calendar"
                text={formatLongDate(start)}
                accessibilityLabel={t('practices.form.dateA11y', { date: formatLongDate(start) })}
                onPress={() => {
                  Keyboard.dismiss();
                  setPicker('date');
                }}
                testID="practice-date-button"
              />
              <PickerRow
                icon="time"
                text={formatClockTime(start)}
                accessibilityLabel={t('practices.form.startTimeA11y', { time: formatClockTime(start) })}
                onPress={() => {
                  Keyboard.dismiss();
                  setPicker('time');
                }}
                testID="practice-time-button"
              />
              <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                {t('practices.form.duration')}
              </ThemedText>
              <DurationPills value={duration} onChange={setDurationEdit} />
              {otherZone && device ? (
                <ThemedText variant="footnote" color="textTertiary">
                  {t('practices.form.timeZoneNote', { zone: device })}
                </ThemedText>
              ) : null}
            </Card>
          ) : null}

          <View style={styles.buttons}>
            <Button
              title={t('common.save')}
              onPress={handleSave}
              loading={saving}
              disabled={saving}
              fullWidth
              size="large"
              testID="practice-edit-save"
            />
            <Button title={t('common.cancel')} variant="outline" onPress={goBack} fullWidth />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <DateTimePickerSheet
        visible={picker !== null}
        mode={picker ?? 'date'}
        value={start}
        title={picker === 'time' ? t('practices.form.startTime') : t('practices.form.date')}
        onConfirm={(value) => {
          setStartEdit(picker === 'time' ? combineDateAndTime(start, value) : combineDateAndTime(value, start));
          setPicker(null);
        }}
        onCancel={() => setPicker(null)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { marginLeft: -spacing.xs },
  headerContent: { flex: 1, alignItems: 'center' },
  headerSpacer: { width: MIN_TOUCH_TARGET },
  scroll: { paddingTop: spacing.lg },
  explain: { marginBottom: spacing.md },
  section: { marginBottom: spacing.md },
  label: { marginTop: spacing.md, marginBottom: spacing.xs },
  buttons: { marginTop: spacing.lg, gap: spacing.md },
});
