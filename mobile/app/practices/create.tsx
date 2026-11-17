/**
 * Schedule a practice (#33): one-off, or recurring weekly / every two weeks on
 * chosen weekdays until an end date or for a number of sessions. Reached from
 * the team schedule (`/teams/[id]/schedule`), so the team is fixed by
 * `?teamId=`. Times are the device's wall time: a series goes out with the
 * device's IANA zone and local "YYYY-MM-DD" / "HH:MM", a one-off as an
 * instant plus that zone. Free on every tier (owner decision 2026-11-15).
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
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
  ErrorState,
  Card,
  SortPills,
} from '../../components';
import { BackButton } from '../../components/BackButton';
import { DateTimePickerSheet } from '../../components/DateTimePickerSheet';
import { useToast } from '../../components/Toast';
import {
  PracticeDetailsFields,
  PickerRow,
  DurationPills,
  type PracticeDetailsValue,
} from '../../components/practice/PracticeFormFields';
import { useCreatePractice, useCreatePracticeSeries } from '../../hooks/usePractices';
import { useTeam, hasTeamPermission } from '../../hooks/useTeams';
import { useAccessGuard } from '../../hooks/useAccessGuard';
import { useGoBack } from '../../hooks/useGoBack';
import { useTheme } from '../../hooks/useTheme';
import { useAuthUser } from '../../store/auth-store';
import { getApiErrorMessage } from '../../services/api-client';
import { useTranslation } from '../../i18n';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { MIN_TOUCH_TARGET } from '../../utils/touch-target';
import {
  deviceTimeZone,
  formatClockTime,
  formatLongDate,
  formatWeekdayName,
} from '../../utils/format-date';
import {
  DEFAULT_PRACTICE_DURATION,
  WEEKDAY_ORDER,
  combineDateAndTime,
  toLocalDateKey,
  toLocalTimeKey,
  validateRecurrence,
  type RecurrenceErrors,
} from '../../utils/practice-schedule';
import type { PracticeFrequency } from '../../types/practice';

type Repeat = 'NONE' | PracticeFrequency;
type PickerTarget = 'date' | 'time' | 'endDate';

/** Tomorrow at 18:00 local: a plausible first practice, never in the past. */
function defaultStart(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(18, 0, 0, 0);
  return date;
}

/** Eight weeks after `start`, a typical block of practices. */
function defaultEnd(start: Date): Date {
  const date = new Date(start);
  date.setDate(date.getDate() + 7 * 8);
  return date;
}

/** An empty optional field is left out of a create body. */
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export default function CreatePracticeScreen() {
  const { teamId = '' } = useLocalSearchParams<{ teamId: string }>();
  const goBack = useGoBack(teamId ? `/teams/${teamId}/schedule` : '/(tabs)/teams');
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const user = useAuthUser();

  const { data: team, error: teamError, refetch: refetchTeam } = useTeam(teamId);
  const createPractice = useCreatePractice();
  const createSeries = useCreatePracticeSeries();
  const saving = createPractice.isPending || createSeries.isPending;

  // Decided only once the team is loaded: a failed team load is an error
  // below, never a permission refusal.
  const canManageTeam = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);
  const allowed = useAccessGuard(!!team && !!user, canManageTeam, t('practices.notAllowed'), {
    fallback: teamId ? `/teams/${teamId}` : '/(tabs)/teams',
  });

  const [details, setDetails] = useState<PracticeDetailsValue>({
    type: 'PRACTICE',
    title: '',
    location: '',
    notes: '',
  });
  const [start, setStart] = useState<Date>(defaultStart);
  const [duration, setDuration] = useState(DEFAULT_PRACTICE_DURATION);
  const [repeat, setRepeat] = useState<Repeat>('NONE');
  const [weekdays, setWeekdays] = useState<number[]>(() => [defaultStart().getDay()]);
  const [endMode, setEndMode] = useState<'date' | 'count'>('date');
  const [endDate, setEndDate] = useState<Date>(() => defaultEnd(defaultStart()));
  const [count, setCount] = useState('10');
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [errors, setErrors] = useState<RecurrenceErrors>({});

  const repeatOptions = useMemo(
    () => [
      { key: 'NONE' as const, label: t('practices.form.repeatNone') },
      { key: 'WEEKLY' as const, label: t('practices.form.repeatWeekly') },
      { key: 'BIWEEKLY' as const, label: t('practices.form.repeatBiweekly') },
    ],
    [t]
  );
  const endOptions = useMemo(
    () => [
      { key: 'date' as const, label: t('practices.form.endOnDate') },
      { key: 'count' as const, label: t('practices.form.endAfterCount') },
    ],
    [t]
  );

  const recurring = repeat !== 'NONE';
  const timeZone = deviceTimeZone();

  // A shown error goes as soon as the coach changes anything it is about.
  const clearErrors = () => setErrors({});

  const toggleWeekday = (day: number) => {
    clearErrors();
    setWeekdays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day]
    );
  };

  const openPicker = (target: PickerTarget) => {
    Keyboard.dismiss();
    setPicker(target);
  };

  const [endTouched, setEndTouched] = useState(false);

  const onPicked = (value: Date) => {
    clearErrors();
    if (picker === 'date') {
      const next = combineDateAndTime(value, start);
      // A one-day pick for a weekly practice usually means "starting this day":
      // carry the weekday along while only one is chosen.
      if (weekdays.length === 1 && weekdays[0] === start.getDay()) setWeekdays([next.getDay()]);
      // Until the coach picks a last date, it stays the default distance from the first.
      if (!endTouched) setEndDate(defaultEnd(next));
      setStart(next);
    } else if (picker === 'time') {
      setStart(combineDateAndTime(start, value));
    } else if (picker === 'endDate') {
      setEndTouched(true);
      setEndDate(value);
    }
    setPicker(null);
  };

  const handleSubmit = async () => {
    if (!timeZone) {
      Alert.alert(t('common.error'), t('practices.errors.noTimeZone'));
      return;
    }
    const base = {
      teamId,
      type: details.type,
      title: optional(details.title),
      location: optional(details.location),
      notes: optional(details.notes),
      durationMinutes: duration,
      timezone: timeZone,
    };
    try {
      if (!recurring) {
        await createPractice.mutateAsync({ ...base, startsAt: start.toISOString() });
        toast.showToast(t('practices.createdOne'), 'success');
      } else {
        const found = validateRecurrence({ weekdays, frequency: repeat, startDate: start, endMode, endDate, count });
        setErrors(found);
        if (Object.keys(found).length > 0) return;
        const series = await createSeries.mutateAsync({
          ...base,
          frequency: repeat,
          weekdays: [...weekdays].sort((a, b) => a - b),
          startDate: toLocalDateKey(start),
          startTime: toLocalTimeKey(start),
          ...(endMode === 'date' ? { endDate: toLocalDateKey(endDate) } : { occurrenceCount: Number(count) }),
        });
        toast.showToast(t('practices.createdSeries', { count: series.sessions?.length ?? 0 }), 'success');
      }
      goBack();
    } catch (error) {
      Alert.alert(t('common.error'), getApiErrorMessage(error, t('practices.errors.createFailed')));
    }
  };

  if (!team && teamError) {
    return (
      <ErrorState
        message={teamError instanceof Error ? teamError.message : t('teams.notFound')}
        onRetry={refetchTeam}
        onBack={goBack}
      />
    );
  }
  if (!team || !allowed) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const pickerValue = picker === 'endDate' ? endDate : start;
  const pickerTitle =
    picker === 'time'
      ? t('practices.form.startTime')
      : picker === 'endDate'
        ? t('practices.form.endDate')
        : recurring
          ? t('practices.form.firstDate')
          : t('practices.form.date');

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
            {t('practices.newTitle')}
          </ThemedText>
          {team ? (
            <ThemedText variant="caption" color="textSecondary" numberOfLines={1}>
              {team.name}
            </ThemedText>
          ) : null}
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { padding, paddingBottom: insets.bottom + spacing.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Card variant="default" style={styles.section}>
            <PracticeDetailsFields value={details} onChange={(patch) => setDetails((d) => ({ ...d, ...patch }))} />
          </Card>

          <Card variant="default" style={styles.section}>
            <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
              {t('practices.form.repeats')}
            </ThemedText>
            <SortPills
              options={repeatOptions}
              selected={repeat}
              onSelect={(key) => { clearErrors(); setRepeat(key); }}
              labelPrefix={t('practices.form.repeatsA11yPrefix')}
              style={styles.pills}
            />

            {recurring && (
              <>
                <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                  {t('practices.form.onDays')}
                </ThemedText>
                <View style={styles.weekdays} testID="practice-weekdays">
                  {WEEKDAY_ORDER.map((day) => {
                    const checked = weekdays.includes(day);
                    return (
                      <TouchableOpacity
                        key={day}
                        onPress={() => toggleWeekday(day)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked }}
                        accessibilityLabel={formatWeekdayName(day, 'long')}
                        style={[
                          styles.weekday,
                          { borderColor: checked ? colors.primary : colors.border },
                          checked && { backgroundColor: colors.primary + '20' },
                        ]}
                      >
                        <ThemedText variant="caption" color={checked ? 'primary' : 'textSecondary'}>
                          {formatWeekdayName(day)}
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {errors.weekdays ? (
                  <ThemedText variant="footnote" color="error" style={styles.error}>
                    {errors.weekdays}
                  </ThemedText>
                ) : null}
              </>
            )}

            <PickerRow
              icon="calendar"
              text={formatLongDate(start)}
              accessibilityLabel={t(recurring ? 'practices.form.firstDateA11y' : 'practices.form.dateA11y', {
                date: formatLongDate(start),
              })}
              onPress={() => openPicker('date')}
              testID="practice-date-button"
            />
            <PickerRow
              icon="time"
              text={formatClockTime(start)}
              accessibilityLabel={t('practices.form.startTimeA11y', { time: formatClockTime(start) })}
              onPress={() => openPicker('time')}
              testID="practice-time-button"
            />

            <ThemedText variant="captionBold" color="textSecondary" style={[styles.label, styles.spaced]}>
              {t('practices.form.duration')}
            </ThemedText>
            <DurationPills value={duration} onChange={setDuration} />

            {recurring && (
              <>
                <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                  {t('practices.form.ends')}
                </ThemedText>
                <SortPills
                  options={endOptions}
                  selected={endMode}
                  onSelect={(key) => { clearErrors(); setEndMode(key); }}
                  labelPrefix={t('practices.form.endsA11yPrefix')}
                  style={styles.pills}
                />
                {endMode === 'date' ? (
                  <>
                    <PickerRow
                      icon="calendar-outline"
                      text={formatLongDate(endDate)}
                      accessibilityLabel={t('practices.form.endDateA11y', { date: formatLongDate(endDate) })}
                      onPress={() => openPicker('endDate')}
                      testID="practice-end-date-button"
                    />
                    {errors.endDate ? (
                      <ThemedText variant="footnote" color="error" style={styles.error}>
                        {errors.endDate}
                      </ThemedText>
                    ) : null}
                  </>
                ) : (
                  <Input
                    label={t('practices.form.count')}
                    value={count}
                    onChangeText={(text) => { clearErrors(); setCount(text); }}
                    keyboardType="number-pad"
                    error={errors.count}
                    testID="practice-count-input"
                  />
                )}
              </>
            )}

            {timeZone ? (
              <ThemedText variant="footnote" color="textTertiary" style={styles.spaced}>
                {t('practices.form.timeZoneNote', { zone: timeZone })}
              </ThemedText>
            ) : null}
          </Card>

          <View style={styles.buttons}>
            <Button
              title={recurring ? t('practices.form.submitSeries') : t('practices.form.submitOne')}
              onPress={handleSubmit}
              loading={saving}
              disabled={saving}
              fullWidth
              size="large"
              testID="practice-create-submit"
            />
            <Button title={t('common.cancel')} variant="outline" onPress={goBack} fullWidth />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <DateTimePickerSheet
        visible={picker !== null}
        mode={picker === 'time' ? 'time' : 'date'}
        value={pickerValue}
        title={pickerTitle}
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
  scrollContent: { paddingTop: spacing.lg },
  section: { marginBottom: spacing.md },
  label: { marginBottom: spacing.xs },
  spaced: { marginTop: spacing.md },
  pills: { flexWrap: 'wrap', marginBottom: spacing.md },
  weekdays: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  weekday: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { marginTop: spacing.xs },
  buttons: { marginTop: spacing.lg, gap: spacing.md },
});
