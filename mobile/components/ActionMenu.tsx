/**
 * Bottom-sheet action menu. Used where a row needs more than two or three
 * actions: React Native's `Alert` renders at most three buttons on Android,
 * so an Alert-based overflow menu silently truncates there (unification
 * review). Items are real pressables — visible to tests and Maestro alike.
 */

import React from 'react';
import { Modal, View, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing, borderRadius } from '../theme';

export interface ActionMenuItem {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

export interface ActionMenuProps {
  visible: boolean;
  title: string;
  items: ActionMenuItem[];
  onClose: () => void;
}

export function ActionMenu({ visible, title, items, onClose }: ActionMenuProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close menu"
      >
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
          // Swallow taps inside the sheet so they don't close the menu
          onPress={() => undefined}
        >
          <ThemedText variant="h4" style={styles.title}>
            {title}
          </ThemedText>
          {items.map((item) => (
            <TouchableOpacity
              key={item.label}
              onPress={() => {
                onClose();
                item.onPress();
              }}
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
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[styles.item, styles.closeItem, { borderTopColor: colors.border }]}
          >
            <ThemedText variant="bodyBold">Close</ThemedText>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
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
