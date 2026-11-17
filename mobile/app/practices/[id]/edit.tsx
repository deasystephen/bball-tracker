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
 * Date and time are the practice's own wall time in its own zone, as the
 * detail screen shows them, whatever zone the device is in: the pickers edit
 * a `WallClock`, and the new start is the instant that clock shows in
 * `practice.timezone` (`instantFromWallClock`), so moving an 18:00 practice
 * across a daylight-saving change keeps it at 18:00 for the team. The zone is
 * named when it is not the device's. Only changed fields are sent; the start
 * goes without a zone, so the session keeps its own.
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
import {
  formatClockTime,
  formatLongDate,
  instantFromWallClock,
  isOtherTimeZone,
  wallClockIn,
  type WallClock,
} from '../../../utils/format-date';
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

/**
 * The picker works on a device `Date`; it only carries the wall clock across
 * (its own zone never matters, its fields are read back as they were set).
 */
function toPickerDate(wall: WallClock): Date {
  return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
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

  const practiceQuery = usePractice(id);
  const practice = practiceQuery.data;
  const seriesQuery = usePracticeSeries(seriesScope ? practice?.seriesId : null);
  const teamQuery = useTeam(practice?.teamId ?? '');
  const team = teamQuery.data;
  const updateOne = useUpdatePractice();
  const updateSeries = useUpdatePracticeSeries();
  const saving = updateOne.isPending || updateSeries.isPending;

  // Decided only once the team is loaded: a failed team load is an error
  // below, never a permission refusal.
  const canManageTeam = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);
  const allowed = useAccessGuard(!!team && !!user, canManageTeam, t('practices.notAllowed'), {
    fallback: `/practices/${id}`,
  });

  // The loaded session ("this one") or series ("all future"), with the user's edits on top.
  const [edits, setEdits] = useState<Partial<PracticeDetailsValue>>({});
  const [wallEdit, setWallEdit] = useState<WallClock | null>(null);
  const [durationEdit, setDurationEdit] = useState<number | null>(null);
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);

  // One failure path: whichever load failed with nothing to show.
  const failed =
    (!practice && practiceQuery.error) ||
    (!!practice && !team && teamQuery.error) ||
    (seriesScope && !seriesQuery.data && seriesQuery.error);
  if (failed) {
    const retry = () => {
      if (practiceQuery.error) practiceQuery.refetch();
      if (teamQuery.error) teamQuery.refetch();
      if (seriesQuery.error) seriesQuery.refetch();
    };
    return (
      <ErrorState
        message={failed instanceof Error ? failed.message : t('practices.notFound')}
        onRetry={retry}
        onBack={goBack}
      />
    );
  }
  // "All future" on a practice that belongs to no series (a stale link).
  if (seriesScope && practice && !practice.seriesId) {
    return <ErrorState message={t('practices.errors.seriesMissing')} onBack={goBack} />;
  }
  const source = seriesScope ? seriesQuery.data : practice;
  if (!practice || !source || !allowed) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const timeZone = practice.timezone;
  const initial = detailsOf(source);
  const details: PracticeDetailsValue = { ...initial, ...edits };
  const wall = wallEdit ?? wallClockIn(practice.startsAt, timeZone);
  // Untouched, the start is the stored instant itself (a repeated autumn hour
  // has two instants for one wall time; the round trip would pick the first).
  const start = wallEdit ? instantFromWallClock(wallEdit, timeZone) : new Date(practice.startsAt);
  const duration = durationEdit ?? practice.durationMinutes;
  const dateText = formatLongDate(start, { timeZone });
  const timeText = formatClockTime(start, { timeZone });

  const handleSave = async () => {
    const patch = changedDetails(initial, details);
    try {
      if (seriesScope && practice.seriesId) {
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

  const openPicker = (mode: 'date' | 'time') => {
    Keyboard.dismiss();
    setPicker(mode);
  };

  const onPicked = (value: Date) => {
    setWallEdit(
      picker === 'time'
        ? { ...wall, hour: value.getHours(), minute: value.getMinutes() }
        : { ...wall, year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() }
    );
    setPicker(null);
  };

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
            {seriesScope
              ? t('practices.menu.editSeries')
              : practice.seriesId
                ? t('practices.menu.editOne')
                : t('practices.menu.edit')}
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
            <PracticeDetailsFields
              value={details}
              onChange={(patch) => setEdits((current) => ({ ...current, ...patch }))}
            />
          </Card>

          {!seriesScope ? (
            <Card variant="default" style={styles.section}>
              <PickerRow
                icon="calendar"
                text={dateText}
                accessibilityLabel={t('practices.form.dateA11y', { date: dateText })}
                onPress={() => openPicker('date')}
                testID="practice-date-button"
              />
              <PickerRow
                icon="time"
                text={timeText}
                accessibilityLabel={t('practices.form.startTimeA11y', { time: timeText })}
                onPress={() => openPicker('time')}
                testID="practice-time-button"
              />
              <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                {t('practices.form.duration')}
              </ThemedText>
              <DurationPills value={duration} onChange={setDurationEdit} />
              {isOtherTimeZone(timeZone, start) ? (
                <ThemedText variant="footnote" color="textTertiary" testID="practice-edit-zone">
                  {t('practices.form.practiceZoneNote', { zone: timeZone })}
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
        value={toPickerDate(wall)}
        title={picker === 'time' ? t('practices.form.startTime') : t('practices.form.date')}
        onConfirm={onPicked}
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
