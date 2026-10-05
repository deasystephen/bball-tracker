/**
 * Bottom-sheet action menu. Used where a row needs more than two or three
 * actions: React Native's `Alert` renders at most three buttons on Android,
 * so an Alert-based overflow menu silently truncates there (unification
 * review). Items are real pressables — visible to tests and Maestro alike.
 *
 * An item that presents native UI (camera, photo library, share sheet,
 * document picker) sets `waitForClose`. iOS refuses to present a view
 * controller while this menu's modal is still dismissing, so on iOS the
 * menu remembers the pressed item, closes, and runs it from
 * `Modal.onDismiss`, with a fallback timer in case that callback never
 * arrives. Android has no such restriction (and no `onDismiss`), so it runs
 * the item at once. Every other item runs immediately on both platforms.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Modal, Platform, TouchableOpacity, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing, borderRadius } from '../theme';

export interface ActionMenuItem {
  label: string;
  destructive?: boolean;
  onPress: () => void;
  /** Run only after the sheet has finished closing (see the file comment). */
  waitForClose?: boolean;
}

/** Longer than the fade-out; reached only if iOS never calls onDismiss. */
export const WAIT_FOR_CLOSE_FALLBACK_MS = 1000;

export interface ActionMenuProps {
  visible: boolean;
  title: string;
  items: ActionMenuItem[];
  onClose: () => void;
}

export function ActionMenu({ visible, title, items, onClose }: ActionMenuProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // The item waiting for the sheet to finish closing, and its fallback timer.
  // At most one is ever pending: whichever of onDismiss and the timer runs
  // first takes it, so it runs exactly once.
  const pending = useRef<(() => void) | null>(null);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    if (fallback.current) {
      clearTimeout(fallback.current);
      fallback.current = null;
    }
    pending.current = null;
  }, []);

  const runPending = useCallback(() => {
    const action = pending.current;
    clearPending();
    action?.();
  }, [clearPending]);

  // Reopening the menu, or unmounting it, drops a choice that has not run:
  // the person is choosing again, or the screen is gone.
  useEffect(() => {
    if (visible) clearPending();
  }, [visible, clearPending]);
  useEffect(() => clearPending, [clearPending]);

  // Close, the backdrop and Android Back: nothing was chosen.
  const dismiss = () => {
    clearPending();
    onClose();
  };

  const pressItem = (item: ActionMenuItem) => {
    // A second item press replaces the first and its timer.
    clearPending();
    onClose();
    if (item.waitForClose && Platform.OS === 'ios') {
      pending.current = item.onPress;
      fallback.current = setTimeout(runPending, WAIT_FOR_CLOSE_FALLBACK_MS);
    } else {
      item.onPress();
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismiss}
      onDismiss={runPending}
    >
      {/* The backdrop and the sheet MUST be siblings, never parent/child: a
          Pressable with an accessibilityLabel becomes a single accessibility
          element on iOS and swallows its entire subtree — with the sheet
          nested inside, VoiceOver (and Maestro) saw one "Close menu" element
          and none of the menu items. */}
      <View style={styles.container}>
        <Pressable
          style={styles.backdrop}
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
          // Claim taps inside the sheet: an unhandled touch would fall
          // through RN hit-testing to the backdrop sibling and close the
          // menu. accessible={false} keeps this wrapper from grouping the
          // items the way the old nested backdrop did.
          onPress={() => undefined}
          accessible={false}
        >
          <ThemedText variant="h4" heading style={styles.title}>
            {title}
          </ThemedText>
          {items.map((item) => (
            <TouchableOpacity
              key={item.label}
              onPress={() => pressItem(item)}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              style={[styles.item, { borderTopColor: colors.border }]}
            >
              <ThemedText
                variant="body"
                style={item.destructive ? { color: colors.error } : undefined}
              >
                {item.label}
              </ThemedText>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[styles.item, styles.closeItem, { borderTopColor: colors.border }]}
          >
            <ThemedText variant="bodyBold">Close</ThemedText>
          </TouchableOpacity>
        </Pressable>
      </View>
    </Modal>
  );
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
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  title: {
    marginBottom: spacing.sm,
  },
  item: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    // 44pt minimum touch target
    minHeight: 44,
    justifyContent: 'center',
  },
  closeItem: {
    marginTop: spacing.xs,
  },
});
