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
 * Date and time are the practice's own wall time, in its zone, whatever
 * zone the device is in (#1051): the form starts from what the practice's
 * clock reads at its start (`wallClockIn`), the pickers edit that date and
 * that "HH:MM" as plain fields, and a change goes out as `startDate` +
 * `startTime` for the API to place in the session's zone (its
 * daylight-saving rule: a skipped time moves forward, a repeated one takes
 * the first). The app never turns a wall time into an instant: converting
 * between zones on the device kept meeting gaps and repeated hours (review
 * of #1049). When the practice's zone is not the device's, the form names
 * it. Only changed fields are sent; no zone goes with the start, so the
 * session keeps its own.
 */

import React, { useState } from 'react';
import { View, StyleSheet, Keyboard, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { FormScrollView } from '../../../components/FormScrollView';
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
  formatLongLocalDate,
  formatTimeZoneLabel,
  formatWallClock,
  isOtherTimeZone,
  wallClockIn,
  type WallClock,
} from '../../../utils/format-date';
import {
  pickerDateFor,
  pickerTimeFor,
  toLocalDateKey,
  toLocalTimeKey,
  validateStartDate,
} from '../../../utils/practice-schedule';
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
  // The date and the time are edited separately, so a refetch that moves the
  // other one (another coach's edit) is not put back by this save.
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  const [timeEdit, setTimeEdit] = useState<string | null>(null);
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
  // The API refuses to edit a cancelled practice, or any session of a
  // cancelled series; say so before the coach fills in a form (the menu that
  // led here may have been built from older data).
  if (
    practice &&
    ((!seriesScope && practice.status === 'CANCELLED') || practice.series?.cancelledAt)
  ) {
    return <ErrorState message={t('practices.errors.notEditable')} onBack={goBack} />;
  }
  const source = seriesScope ? seriesQuery.data : practice;
  if (!practice || !source || !allowed) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const timeZone = practice.timezone;
  const initial = detailsOf(source);
  const details: PracticeDetailsValue = { ...initial, ...edits };
  // The practice's own wall time at its start, and the coach's edit of it.
  // Null when this device cannot read the practice's clock (a zone its
  // runtime does not know): the date and time are then neither shown nor
  // offered for change, since the device's clock would be another zone's.
  const storedWall = wallClockIn(practice.startsAt, timeZone);
  const start: WallClock | null = storedWall
    ? { date: dateEdit ?? storedWall.date, time: timeEdit ?? storedWall.time }
    : null;
  const startMoved = !!start && !!storedWall && (start.date !== storedWall.date || start.time !== storedWall.time);
  const duration = durationEdit ?? practice.durationMinutes;
  const dateText = start ? formatLongLocalDate(start.date) : '';
  const timeText = start ? formatWallClock(start.time) : '';
  // Named when the practice's clock is not the device's: at its start, now,
  // or on the date picked.
  const otherZone =
    isOtherTimeZone(timeZone, practice.startsAt) ||
    isOtherTimeZone(timeZone) ||
    (!!start && isOtherTimeZone(timeZone, pickerDateFor(start.date)));

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
        if (start && startMoved) {
          // The API's one-off window, by calendar day in the practice's zone,
          // before a round trip.
          const today = wallClockIn(new Date(), timeZone);
          const windowError = validateStartDate(
            pickerDateFor(start.date),
            false,
            today ? pickerDateFor(today.date) : new Date()
          );
          if (windowError) {
            Alert.alert(t('common.error'), windowError);
            return;
          }
          // Wall time in the practice's zone; the API turns it into an instant.
          data.startDate = start.date;
          data.startTime = start.time;
        }
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

  // The picker's Date only carries the field being picked (see pickerDateFor).
  const onPicked = (value: Date) => {
    if (picker === 'time') setTimeEdit(toLocalTimeKey(value));
    else setDateEdit(toLocalDateKey(value));
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
        <FormScrollView
          contentContainerStyle={[styles.scroll, { padding, paddingBottom: insets.bottom + spacing.xl }]}
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
              {start ? (
                <>
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
                </>
              ) : (
                <ThemedText variant="footnote" color="textSecondary" testID="practice-edit-zone-unknown">
                  {t('practices.form.zoneUnknown', { zone: timeZone })}
                </ThemedText>
              )}
              {start && otherZone ? (
                <ThemedText variant="footnote" color="textSecondary" testID="practice-edit-zone">
                  {t('practices.form.practiceZoneNote', { zone: formatTimeZoneLabel(timeZone) })}
                </ThemedText>
              ) : null}
              <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                {t('practices.form.duration')}
              </ThemedText>
              <DurationPills value={duration} onChange={setDurationEdit} />
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
        </FormScrollView>
      </KeyboardAvoidingView>

      <DateTimePickerSheet
        visible={picker !== null && !!start}
        mode={picker ?? 'date'}
        value={start ? (picker === 'time' ? pickerTimeFor(start.time) : pickerDateFor(start.date)) : new Date()}
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
