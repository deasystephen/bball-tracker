/**
 * Date or time picker that the user confirms.
 *
 * iOS: a bottom sheet with the wheels, Cancel and Done. The wheels edit a
 * draft; nothing reaches the screen until Done. The picker used to be rendered
 * inline at the end of the form and closed itself on the first change, so it
 * appeared under the keyboard (or below the fold) and vanished as soon as one
 * wheel settled (#576).
 *
 * Android: the library shows the system dialog, which has its own OK/Cancel.
 */

import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing, borderRadius } from '../theme';

export type DateTimePickerSheetMode = 'date' | 'time';

export interface DateTimePickerSheetProps {
  visible: boolean;
  mode: DateTimePickerSheetMode;
  /** The value the picker opens on. */
  value: Date;
  title: string;
  /** Called with the chosen value; the owner closes the sheet. */
  onConfirm: (value: Date) => void;
  /** Called when the user backs out; the owner closes the sheet. */
  onCancel: () => void;
}

type SheetProps = Omit<DateTimePickerSheetProps, 'visible'>;

function IosSheet({ mode, value, title, onConfirm, onCancel }: SheetProps) {
  const { colors, colorScheme } = useTheme();
  const insets = useSafeAreaInsets();
  // Mounted only while the sheet is open, so every opening starts from `value`.
  const [draft, setDraft] = useState(value);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      {/* Backdrop and sheet are siblings, for the reason given in ActionMenu. */}
      <View style={styles.container}>
        <Pressable
          style={styles.backdrop}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close picker"
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.background, paddingBottom: insets.bottom + spacing.md },
          ]}
        >
          <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
            <TouchableOpacity
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              testID="date-time-picker-cancel"
              style={styles.toolbarButton}
            >
              <ThemedText variant="body" color="textSecondary">
                Cancel
              </ThemedText>
            </TouchableOpacity>
            <ThemedText variant="bodyBold" accessibilityRole="header">
              {title}
            </ThemedText>
            <TouchableOpacity
              onPress={() => onConfirm(draft)}
              accessibilityRole="button"
              accessibilityLabel="Done"
              testID="date-time-picker-done"
              style={[styles.toolbarButton, styles.toolbarButtonEnd]}
            >
              <ThemedText variant="bodyBold" color="primary">
                Done
              </ThemedText>
            </TouchableOpacity>
          </View>
          {/* The wheels have a fixed natural width; without this they hug the left edge. */}
          <View style={styles.wheels}>
            <DateTimePicker
              testID="date-time-picker"
              value={draft}
              mode={mode}
              display="spinner"
              themeVariant={colorScheme}
              onValueChange={(_event, selected) => setDraft(selected)}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function DateTimePickerSheet({ visible, ...sheet }: DateTimePickerSheetProps) {
  if (!visible) return null;

  if (Platform.OS !== 'ios') {
    return (
      <DateTimePicker
        testID="date-time-picker"
        value={sheet.value}
        mode={sheet.mode}
        onValueChange={(_event, selected) => sheet.onConfirm(selected)}
        onDismiss={sheet.onCancel}
      />
    );
  }

  return <IosSheet {...sheet} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sheet: {
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarButton: {
    // 44pt minimum touch target
    minHeight: 44,
    minWidth: 72,
    justifyContent: 'center',
  },
  toolbarButtonEnd: {
    alignItems: 'flex-end',
  },
  wheels: {
    alignItems: 'center',
  },
});
