/**
 * Profile screen - user profile and settings
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useAuthStore } from '../../store/auth-store';
import { canAccessAdmin } from '../../utils/team-permissions';
import { guardianChildren, isGuardian, relationshipLabel } from '../../utils/guardian';
import { useThemeStore } from '../../store/theme-store';
import { useTheme } from '../../hooks/useTheme';
import { useTeams, TEAMS_MAX_LIMIT } from '../../hooks/useTeams';
import { useUpdateProfile } from '../../hooks/useProfile';
import { useUsage } from '../../hooks/useUsage';
import { ThemedView, ThemedText, Card, AvatarPicker, UsageMeter } from '../../components';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { uploadAvatar } from '../../services/upload-service';
import { useTranslation } from '../../i18n';
import { captureException } from '../../services/sentry';

export default function Profile() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { colors, colorScheme } = useTheme();
  const { toggleColorScheme } = useThemeStore();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const { data: teams } = useTeams({ limit: TEAMS_MAX_LIMIT });
  const { data: usage } = useUsage();
  const updateProfile = useUpdateProfile();
  const { t } = useTranslation();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const handleAvatarSelected = async (uri: string | null) => {
    if (!user?.id) return;

    if (!uri) {
      // Remove photo
      try {
        // PATCH /auth/me works for every role; the hook merges the result
        // into the auth store (audit #10).
        await updateProfile.mutateAsync({ profilePictureUrl: '' });
      } catch {
        Alert.alert('Error', 'Failed to remove photo');
      }
      return;
    }

    try {
      setUploadingAvatar(true);
      const imageUrl = await uploadAvatar(uri);
      await updateProfile.mutateAsync({ profilePictureUrl: imageUrl });
    } catch (err) {
      captureException(err, { flow: 'avatar-change' });
      const message = err instanceof Error && err.message ? err.message : 'Failed to upload photo';
      Alert.alert('Error', message);
    } finally {
      setUploadingAvatar(false);
    }
  };

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
          <View style={styles.avatarContainer}>
            <AvatarPicker
              uri={user?.profilePictureUrl}
              name={user?.name || ''}
              size="large"
              onImageSelected={handleAvatarSelected}
            />
            {uploadingAvatar && (
              <ThemedText variant="caption" color="textSecondary" style={styles.uploadingText}>
                Uploading...
              </ThemedText>
            )}
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

        {/* My kids — guardians (PARENT role, `guardianOf` from GET /auth/me).
            Each child opens their stats; a coach who is also a parent sees
            this too (guardian links are independent of the global role). */}
        {isGuardian(user) && (
          <View style={styles.section} testID="my-kids-section">
            <ThemedText variant="h4" style={styles.sectionTitle}>
              My kids
            </ThemedText>
            <Card variant="default" style={styles.settingsCard}>
              {guardianChildren(user).map((child, index) => (
                <React.Fragment key={child.childId}>
                  {index > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
                  <TouchableOpacity
                    style={styles.settingRow}
                    accessibilityRole="button"
                    accessibilityLabel={`${child.childName}, ${relationshipLabel(child.relationship)}`}
                    onPress={() => router.push(`/players/${child.childId}/stats`)}
                  >
                    <View style={styles.settingLeft}>
                      <View style={[styles.settingIcon, { backgroundColor: colors.primary + '20' }]}>
                        <Ionicons name="people" size={18} color={colors.primary} />
                      </View>
                      <View style={styles.settingContent}>
                        <ThemedText variant="body">{child.childName}</ThemedText>
                        <ThemedText variant="caption" color="textSecondary">
                          {relationshipLabel(child.relationship)}
                          {child.isPrimary ? ' \u00B7 Primary' : ''}
                        </ThemedText>
                      </View>
                    </View>
                    {child.teams && child.teams.length > 0 ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Manage guardians for ${child.childName}`}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        onPress={() =>
                          router.push(`/teams/${child.teams![0].id}/players/${child.childId}/guardians`)
                        }
                      >
                        <Ionicons name="people-circle-outline" size={24} color={colors.primary} />
                      </TouchableOpacity>
                    ) : (
                      <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                    )}
                  </TouchableOpacity>
                </React.Fragment>
              ))}
            </Card>
          </View>
        )}

        {/* Account Info */}
        <View style={styles.section}>
          <ThemedText variant="h4" style={styles.sectionTitle}>
            Account
          </ThemedText>
          <Card variant="default" style={styles.infoCard}>
            {/* Name row opens the shared display-name screen in edit mode
                (PATCH /auth/me — see app/onboarding/name.tsx). */}
            <TouchableOpacity
              style={styles.infoRow}
              accessibilityRole="button"
              accessibilityLabel="Edit name"
              onPress={() => router.push('/onboarding/name?from=profile')}
            >
              <View style={[styles.infoIcon, { backgroundColor: colors.primary + '20' }]}>
                <Ionicons name="person" size={18} color={colors.primary} />
              </View>
              <View style={styles.infoContent}>
                <ThemedText variant="caption" color="textSecondary">
                  Name
                </ThemedText>
                <ThemedText variant="body">{user?.name || 'Not set'}</ThemedText>
              </View>
              <Ionicons name="pencil" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
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

        {/* Plan Usage Meter */}
        {usage && (
          <View style={styles.section}>
            <ThemedText variant="h4" style={styles.sectionTitle}>
              {t('usage.title')}
            </ThemedText>
            <Card variant="default" style={styles.infoCard}>
              <UsageMeter
                label={t('usage.teams')}
                metric={usage.teams}
                upgradeHint={t('usage.upgradeForUnlimited')}
              />
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <UsageMeter
                label={t('usage.seasons')}
                metric={usage.seasons}
                upgradeHint={t('usage.upgradeForUnlimited')}
              />
            </Card>
          </View>
        )}

        {/* Account type (PLAYER <-> COACH self-select). Hidden for guardians:
            PARENT is derived from guardian links, never self-selected. */}
        {(user?.role === 'PLAYER' || user?.role === 'COACH') && !isGuardian(user) && (
          <View style={styles.section}>
            <ThemedText variant="h4" style={styles.sectionTitle}>
              {t('roleOnboarding.sectionTitle')}
            </ThemedText>
            <Card variant="default" style={styles.settingsCard}>
              <TouchableOpacity
                style={styles.settingRow}
                accessibilityLabel={t('roleOnboarding.changeRole')}
                onPress={() => router.push('/onboarding/role?from=profile')}
              >
                <View style={styles.settingLeft}>
                  <View style={[styles.settingIcon, { backgroundColor: colors.primary + '20' }]}>
                    <Ionicons name="swap-horizontal" size={18} color={colors.primary} />
                  </View>
                  <View style={styles.settingContent}>
                    <ThemedText variant="body">{t('roleOnboarding.changeRole')}</ThemedText>
                    <ThemedText variant="caption" color="textSecondary">
                      {user.role === 'COACH' ? t('roleOnboarding.currentCoach') : t('roleOnboarding.currentPlayer')}
                    </ThemedText>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
              </TouchableOpacity>
            </Card>
          </View>
        )}

        {/* Admin Section — system ADMINs and league admins (`leagueAdminOf`
            from GET /auth/me); the admin screens guard themselves too. */}
        {canAccessAdmin(user) && (
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
            {/* Version/OTA diagnostics + future ToS/privacy home (#25). The
                version here comes from the manifest, replacing the hardcoded
                footer string that had drifted to v1.0.0. */}
            <TouchableOpacity
              style={styles.settingRow}
              onPress={() => router.push('/about')}
              accessibilityRole="button"
              accessibilityLabel="About"
            >
              <View style={styles.settingLeft}>
                <View style={[styles.settingIcon, { backgroundColor: colors.primary + '20' }]}>
                  <Ionicons name="information-circle" size={18} color={colors.primary} />
                </View>
                <View style={styles.settingContent}>
                  <ThemedText variant="body">About</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {`Version ${Constants.expoConfig?.version ?? 'unknown'}`}
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

      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingBottom: spacing.xl * 2 },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  avatarContainer: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  uploadingText: {
    marginTop: spacing.xs,
  },
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
});
