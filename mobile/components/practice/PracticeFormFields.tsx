/**
 * Form pieces shared by the practice create and edit screens (#33): the
 * descriptive fields (type, title, location, notes), a picker row that opens
 * `DateTimePickerSheet`, and the duration pills.
 */

import React, { useMemo } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '../ThemedText';
import { Input } from '../Input';
import { SortPills } from '../SortPills';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing, borderRadius } from '../../theme';
import { MIN_TOUCH_TARGET } from '../../utils/touch-target';
import {
  PRACTICE_DURATIONS,
  PRACTICE_LOCATION_MAX,
  PRACTICE_NOTES_MAX,
  PRACTICE_TITLE_MAX,
} from '../../utils/practice-schedule';
import type { PracticeType } from '../../types/practice';

export interface PracticeDetailsValue {
  type: PracticeType;
  title: string;
  location: string;
  notes: string;
}

export function PracticeDetailsFields({
  value,
  onChange,
}: {
  value: PracticeDetailsValue;
  onChange: (patch: Partial<PracticeDetailsValue>) => void;
}) {
  const { t } = useTranslation();
  const typeOptions = useMemo(
    () => [
      { key: 'PRACTICE' as const, label: t('practices.typePractice') },
      { key: 'OTHER' as const, label: t('practices.typeOther') },
    ],
    [t]
  );

  return (
    <View>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
        {t('practices.form.type')}
      </ThemedText>
      <SortPills
        options={typeOptions}
        selected={value.type}
        onSelect={(type) => onChange({ type })}
        labelPrefix={t('practices.form.typeA11yPrefix')}
        style={styles.pills}
      />
      <Input
        label={t('practices.form.title')}
        placeholder={
          value.type === 'OTHER' ? t('practices.form.titlePlaceholderOther') : t('practices.form.titlePlaceholder')
        }
        value={value.title}
        onChangeText={(title) => onChange({ title })}
        maxLength={PRACTICE_TITLE_MAX}
        autoCapitalize="sentences"
        testID="practice-title-input"
      />
      <Input
        label={t('practices.form.location')}
        placeholder={t('practices.form.locationPlaceholder')}
        value={value.location}
        onChangeText={(location) => onChange({ location })}
        maxLength={PRACTICE_LOCATION_MAX}
        testID="practice-location-input"
      />
      <Input
        label={t('practices.form.notes')}
        placeholder={t('practices.form.notesPlaceholder')}
        value={value.notes}
        onChangeText={(notes) => onChange({ notes })}
        maxLength={PRACTICE_NOTES_MAX}
        multiline
        testID="practice-notes-input"
      />
    </View>
  );
}

/** A row that shows a date or time and opens the picker sheet. */
export function PickerRow({
  icon,
  text,
  accessibilityLabel,
  onPress,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.pickerRow, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Ionicons name={icon} size={20} color={colors.primary} />
      <ThemedText variant="body">{text}</ThemedText>
    </TouchableOpacity>
  );
}

/** Duration pills; a stored duration that is not one of the choices is offered too. */
export function DurationPills({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  const { t } = useTranslation();
  const options = useMemo(() => {
    const minutes: number[] = [...PRACTICE_DURATIONS];
    if (!minutes.includes(value)) minutes.push(value);
    minutes.sort((a, b) => a - b);
    return minutes.map((m) => ({ key: String(m), label: t('practices.minutes', { count: m }) }));
  }, [value, t]);
  return (
    <SortPills
      options={options}
      selected={String(value)}
      onSelect={(key) => onChange(Number(key))}
      labelPrefix={t('practices.form.durationA11yPrefix')}
      style={styles.pills}
    />
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: spacing.xs },
  pills: { flexWrap: 'wrap', marginBottom: spacing.md },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    marginTop: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
});
