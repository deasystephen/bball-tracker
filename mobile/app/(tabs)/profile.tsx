/**
 * Profile screen - user profile and settings
 */

import React from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../store/auth-store';
import { useThemeStore } from '../../store/theme-store';
import { useTheme } from '../../hooks/useTheme';
import { useTeams } from '../../hooks/useTeams';
import { ThemedView, ThemedText, Card } from '../../components';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

export default function Profile() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { colors, colorScheme } = useTheme();
  const { toggleColorScheme } = useThemeStore();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const { data: teams } = useTeams();

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: () => {
          logout();
          router.replace('/login');
        },
      },
    ]);
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getRoleIcon = (role: string): keyof typeof Ionicons.glyphMap => {
    switch (role) {
      case 'COACH':
        return 'clipboard';
      case 'ADMIN':
        return 'shield';
      case 'PARENT':
        return 'people';
      default:
        return 'person';
    }
  };

  return (
    <ThemedView variant="background" style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: padding, paddingTop: insets.top + spacing.lg },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Header with ring */}
        <View style={styles.header}>
          <View style={[styles.avatarRing, { borderColor: colors.primary }]}>
            <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
              <ThemedText variant="h1" style={styles.avatarText}>
                {user?.name ? getInitials(user.name) : '?'}
              </ThemedText>
            </View>
          </View>
          <ThemedText variant="h2" style={styles.userName}>
            {user?.name || 'User'}
          </ThemedText>
          <View style={styles.roleChip}>
            <Ionicons
              name={getRoleIcon(user?.role || 'PLAYER')}
              size={14}
              color={colors.primary}
            />
            <ThemedText variant="caption" color="primary" style={styles.roleText}>
              {user?.role || 'Player'}
            </ThemedText>
          </View>
          {/* Season summary line */}
          <ThemedText variant="caption" color="textSecondary" style={styles.seasonSummary}>
            {teams?.length || 0} team{(teams?.length || 0) !== 1 ? 's' : ''}
          </ThemedText>
        </View>

        {/* My Stats Quick Card (for players) */}
        {user?.role !== 'COACH' && user?.role !== 'ADMIN' && user?.id && (
          <TouchableOpacity
            style={[styles.myStatsCard, { backgroundColor: colors.backgroundSecondary }]}
            onPress={() => router.push(`/players/${user.id}/stats`)}
          >
            <View style={[styles.myStatsIcon, { backgroundColor: colors.primary + '20' }]}>
              <Ionicons name="stats-chart" size={20} color={colors.primary} />
            </View>
            <View style={styles.myStatsInfo}>
              <ThemedText variant="bodyBold">My Stats</ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                View your personal statistics
              </ThemedText>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        )}

        {/* Account Info */}
        <View style={styles.section}>
          <ThemedText variant="h4" style={styles.sectionTitle}>
            Account
          </ThemedText>
          <Card variant="default" style={styles.infoCard}>
            <View style={styles.infoRow}>
              <View style={[styles.infoIcon, { backgroundColor: colors.primary + '20' }]}>
                <Ionicons name="mail" size={18} color={colors.primary} />
              </View>
              <View style={styles.infoContent}>
                <ThemedText variant="caption" color="textSecondary">
                  Email
                </ThemedText>
                <ThemedText variant="body">{user?.email || 'Not set'}</ThemedText>
              </View>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.infoRow}>
              <View style={[styles.infoIcon, { backgroundColor: colors.success + '20' }]}>
                <Ionicons name="checkmark-circle" size={18} color={colors.success} />
              </View>
              <View style={styles.infoContent}>
                <ThemedText variant="caption" color="textSecondary">
                  Account Status
                </ThemedText>
                <ThemedText variant="body">Active</ThemedText>
              </View>
            </View>
          </Card>
        </View>

        {/* Admin Section */}
        {(user?.role === 'ADMIN' || user?.role === 'COACH') && (
          <View style={styles.section}>
            <ThemedText variant="h4" style={styles.sectionTitle}>
              Management
            </ThemedText>
            <Card variant="default" style={styles.settingsCard}>
              <TouchableOpacity style={styles.settingRow} onPress={() => router.push('/admin')}>
                <View style={styles.settingLeft}>
                  <View style={[styles.settingIcon, { backgroundColor: colors.primary + '20' }]}>
                    <Ionicons name="trophy" size={18} color={colors.primary} />
                  </View>
                  <View style={styles.settingContent}>
                    <ThemedText variant="body">Leagues & Seasons</ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      Create and manage leagues
                    </ThemedText>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
              </TouchableOpacity>
            </Card>
          </View>
        )}

        {/* Settings */}
        <View style={styles.section}>
          <ThemedText variant="h4" style={styles.sectionTitle}>
            Settings
          </ThemedText>
          <Card variant="default" style={styles.settingsCard}>
            <TouchableOpacity
              style={styles.settingRow}
              onPress={toggleColorScheme}
              accessibilityRole="switch"
              accessibilityLabel="Toggle dark mode"
              accessibilityState={{ checked: colorScheme === 'dark' }}
            >
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: colors.warning + '20' }]}>
                  <Ionicons
                    name={colorScheme === 'dark' ? 'moon' : 'sunny'}
                    size={18}
                    color={colors.warning}
                  />
                </View>
                <View style={styles.settingContent}>
                  <ThemedText variant="body">Appearance</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {colorScheme === 'dark' ? 'Dark Mode' : 'Light Mode'}
                  </ThemedText>
                </View>
              </View>
              <View
                style={[
                  styles.toggle,
                  {
                    backgroundColor:
                      colorScheme === 'dark' ? colors.primary : colors.border,
                  },
                ]}
              >
                <View
                  style={[
                    styles.toggleKnob,
                    colorScheme === 'dark' && styles.toggleKnobActive,
                  ]}
                />
              </View>
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity style={styles.settingRow} onPress={() => router.push('/notifications')}>
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: colors.info + '20' }]}>
                  <Ionicons name="notifications" size={18} color={colors.info} />
                </View>
                <View style={styles.settingContent}>
                  <ThemedText variant="body">Notifications</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    Manage notification preferences
                  </ThemedText>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
            </TouchableOpacity>
          </Card>
        </View>

        {/* Logout */}
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.logoutButton, { backgroundColor: colors.error + '15' }]}
            onPress={handleLogout}
            accessibilityRole="button"
            accessibilityLabel="Logout"
          >
            <Ionicons name="log-out-outline" size={20} color={colors.error} />
            <ThemedText variant="body" style={[styles.logoutText, { color: colors.error }]}>
              Logout
            </ThemedText>
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <ThemedText variant="caption" color="textTertiary">
            Basketball Tracker v1.0.0
          </ThemedText>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingBottom: spacing.xl * 2 },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  avatarRing: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { color: '#FFFFFF', fontWeight: '700' },
  userName: { marginBottom: spacing.xs },
  roleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
  },
  roleText: { fontWeight: '600' },
  seasonSummary: { marginTop: spacing.xs },
  myStatsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    marginBottom: spacing.lg,
  },
  myStatsIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  myStatsInfo: { flex: 1 },
  section: { marginBottom: spacing.lg },
  sectionTitle: { marginBottom: spacing.sm, marginLeft: spacing.xs },
  infoCard: { padding: spacing.md },
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
  settingsCard: { padding: spacing.sm },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingContent: { flex: 1 },
  toggle: {
    width: 50,
    height: 30,
    borderRadius: 15,
    padding: 2,
    justifyContent: 'center',
  },
  toggleKnob: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#FFFFFF',
  },
  toggleKnobActive: { alignSelf: 'flex-end' },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
  },
  logoutText: { fontWeight: '600' },
  footer: { alignItems: 'center', marginTop: spacing.lg },
});
