/**
 * About screen — version and OTA-update diagnostics (Profile → About).
 *
 * Answers "what is actually loaded on this device": app + runtime version
 * from expo-constants and, via expo-updates, the applied update's id,
 * publish time and channel (or "Embedded" when the binary's bundled JS is
 * running, i.e. no OTA has applied yet). Share exports the same fields as
 * text for pasting into a bug report or an OTA verification thread.
 *
 * Also the future home of legal content: Terms of Service, Privacy Policy
 * and open-source licenses get rows here once published (#25) — add them
 * below the diagnostics card.
 */

import React from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Share } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { ThemedView, ThemedText, Card, Button } from '../components';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { getHorizontalPadding } from '../utils/responsive';

export const APP_NAME = 'Basketball Tracker';

export interface AboutInfo {
  appVersion: string;
  runtimeVersion: string | null;
  updateId: string | null;
  updatePublishedAt: Date | null;
  channel: string | null;
  isEmbedded: boolean;
}

/** Snapshot the expo-constants / expo-updates fields the screen renders. */
export function getAboutInfo(): AboutInfo {
  const runtime = Updates.runtimeVersion ?? Constants.expoConfig?.version ?? null;
  // In a dev client expo-updates is disabled: no update ever applies, so the
  // running JS is by definition the local bundle.
  const isEmbedded = !Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.updateId;
  return {
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    runtimeVersion: runtime,
    updateId: isEmbedded ? null : Updates.updateId,
    updatePublishedAt: isEmbedded ? null : (Updates.createdAt ?? null),
    channel: Updates.channel || null,
    isEmbedded,
  };
}

export function formatAboutDiagnostics(info: AboutInfo): string {
  return [
    `${APP_NAME} v${info.appVersion}`,
    `Runtime version: ${info.runtimeVersion ?? 'unknown'}`,
    info.isEmbedded
      ? 'Update: embedded build (no OTA applied)'
      : `Update: ${info.updateId} (published ${info.updatePublishedAt?.toISOString() ?? 'unknown'})`,
    `Channel: ${info.channel ?? 'none (development)'}`,
  ].join('\n');
}

export default function AboutScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const padding = getHorizontalPadding();
  const info = getAboutInfo();

  const handleShare = async () => {
    try {
      await Share.share({ message: formatAboutDiagnostics(info) });
    } catch {
      // User dismissed the share sheet or it is unavailable — nothing to do.
    }
  };

  const rows: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }[] = [
    { icon: 'pricetag', label: 'App version', value: `v${info.appVersion}` },
    { icon: 'layers', label: 'Runtime version', value: info.runtimeVersion ?? 'unknown' },
    {
      icon: 'cloud-download',
      label: 'Update',
      value: info.isEmbedded
        ? 'Embedded build (no OTA applied)'
        : `${info.updateId}\nPublished ${info.updatePublishedAt?.toLocaleString() ?? 'unknown'}`,
    },
    { icon: 'git-branch', label: 'Channel', value: info.channel ?? 'none (development)' },
  ];

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.topHeader,
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
          <ThemedText variant="h2">About</ThemedText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingHorizontal: padding }]}
        showsVerticalScrollIndicator={false}
      >
        <ThemedText variant="h4" style={styles.sectionTitle}>
          {APP_NAME}
        </ThemedText>
        <Card variant="default" style={styles.card}>
          {rows.map((row, index) => (
            <React.Fragment key={row.label}>
              {index > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
              <View style={styles.infoRow}>
                <View style={[styles.infoIcon, { backgroundColor: colors.primary + '20' }]}>
                  <Ionicons name={row.icon} size={18} color={colors.primary} />
                </View>
                <View style={styles.infoContent}>
                  <ThemedText variant="caption" color="textSecondary">
                    {row.label}
                  </ThemedText>
                  <ThemedText variant="body" testID={`about-${row.label.toLowerCase().replace(/ /g, '-')}`}>
                    {row.value}
                  </ThemedText>
                </View>
              </View>
            </React.Fragment>
          ))}
        </Card>

        <Button
          title="Share diagnostics"
          variant="outline"
          onPress={handleShare}
          fullWidth
          style={styles.shareButton}
        />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    padding: spacing.sm,
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: { flex: 1 },
  scrollContent: { paddingTop: spacing.lg, paddingBottom: spacing.xl * 2 },
  sectionTitle: { marginBottom: spacing.sm, marginLeft: spacing.xs },
  card: { padding: spacing.md },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  infoIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  infoContent: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.xs },
  shareButton: { marginTop: spacing.lg },
});
