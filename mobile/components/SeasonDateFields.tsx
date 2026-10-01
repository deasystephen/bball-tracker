/**
 * The optional start and end date rows of the season forms, with the picker
 * sheet they open. Create and Edit share this one component so the two forms
 * cannot drift (#614).
 *
 * Each date row is a button that opens the sheet, with a clear button beside
 * it once a date is set. The two are siblings, never parent and child: a
 * pressable inside a pressable is one element to VoiceOver and Maestro (#583).
 */

import React, { useState } from 'react';
import { View, StyleSheet, Keyboard, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from './ThemedText';
import { DateTimePickerSheet } from './DateTimePickerSheet';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../i18n';
import { spacing, borderRadius } from '../theme';

export interface SeasonDateFieldsProps {
  startDate: Date | null;
  endDate: Date | null;
  onChangeStart: (date: Date | null) => void;
  onChangeEnd: (date: Date | null) => void;
  /** Range validation message, shown under the rows. */
  error?: string;
}

/** The long form the rows show, e.g. "March 6, 2027". */
export function formatSeasonDate(date: Date | null, notSet: string): string {
  if (!date) return notSet;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function SeasonDateFields({
  startDate,
  endDate,
  onChangeStart,
  onChangeEnd,
  error,
}: SeasonDateFieldsProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [picker, setPicker] = useState<'start' | 'end' | null>(null);

  const openPicker = (which: 'start' | 'end') => {
    // The name field above takes focus when the form opens; its keyboard would
    // otherwise sit on top of the sheet.
    Keyboard.dismiss();
    setPicker(which);
  };

  const notSet = t('seasons.notSet');
  const rowStyle = [
    styles.dateRow,
    { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
  ];

  return (
    <View style={styles.section}>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
        {t('seasons.dates')}
      </ThemedText>

      <View style={rowStyle}>
        <TouchableOpacity
          style={styles.dateButton}
          onPress={() => openPicker('start')}
          accessibilityRole="button"
          accessibilityLabel={`${t('seasons.startDate')}: ${formatSeasonDate(startDate, notSet)}`}
          testID="season-start-date-button"
        >
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <View style={styles.dateContent}>
            <ThemedText variant="caption" color="textSecondary">
              {t('seasons.startDate')}
            </ThemedText>
            <ThemedText variant="body">{formatSeasonDate(startDate, notSet)}</ThemedText>
          </View>
        </TouchableOpacity>
        {startDate && (
          <TouchableOpacity
            onPress={() => onChangeStart(null)}
            style={styles.clearButton}
            accessibilityRole="button"
            accessibilityLabel={t('seasons.clearStart')}
            testID="season-start-date-clear"
          >
            <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      <View style={rowStyle}>
        <TouchableOpacity
          style={styles.dateButton}
          onPress={() => openPicker('end')}
          accessibilityRole="button"
          accessibilityLabel={`${t('seasons.endDate')}: ${formatSeasonDate(endDate, notSet)}`}
          testID="season-end-date-button"
        >
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <View style={styles.dateContent}>
            <ThemedText variant="caption" color="textSecondary">
              {t('seasons.endDate')}
            </ThemedText>
            <ThemedText variant="body">{formatSeasonDate(endDate, notSet)}</ThemedText>
          </View>
        </TouchableOpacity>
        {endDate && (
          <TouchableOpacity
            onPress={() => onChangeEnd(null)}
            style={styles.clearButton}
            accessibilityRole="button"
            accessibilityLabel={t('seasons.clearEnd')}
            testID="season-end-date-clear"
          >
            <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      {error && (
        <ThemedText variant="caption" color="error" style={styles.error} testID="season-dates-error">
          {error}
        </ThemedText>
      )}

      <DateTimePickerSheet
        visible={picker !== null}
        mode="date"
        value={(picker === 'end' ? endDate : startDate) ?? new Date()}
        title={picker === 'end' ? t('seasons.endDateSheet') : t('seasons.startDateSheet')}
        onConfirm={(selected) => {
          if (picker === 'end') {
            onChangeEnd(selected);
          } else {
            onChangeStart(selected);
          }
          setPicker(null);
        }}
        onCancel={() => setPicker(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    marginTop: spacing.sm,
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    flex: 1,
  },
  dateContent: {
    flex: 1,
  },
  clearButton: {
    // 44pt minimum touch target
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    marginTop: spacing.sm,
  },
});
