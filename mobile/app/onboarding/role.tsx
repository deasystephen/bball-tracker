/**
 * Post-login role selection: "I coach a team" vs "I play on a team".
 *
 * Shown once to PLAYER accounts after sign-in (see utils/role-onboarding.ts)
 * and reachable again from Profile → "Change account type". Picking coach
 * calls PATCH /auth/me/role so the user can create teams.
 */

import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Button } from '../../components';
import { useTheme } from '../../hooks/useTheme';
import { useAuthUser, useAuthActions } from '../../store/auth-store';
import { apiClient } from '../../services/api-client';
import { captureException } from '../../services/sentry';
import { useTranslation } from '../../i18n';
import { UserRole } from '../../../shared/types';
import { markRoleChosen, HOME_ROUTE } from '../../utils/role-onboarding';
import { spacing, borderRadius } from '../../theme';

type Choice = UserRole.PLAYER | UserRole.COACH;

export default function RoleSelectScreen() {
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const user = useAuthUser();
  const { updateUser } = useAuthActions();
  const [selected, setSelected] = useState<Choice | null>(
    user?.role === UserRole.COACH ? UserRole.COACH : null
  );
  const [saving, setSaving] = useState(false);

  // Only the Profile → "Change account type" path should pop back. On the
  // first-login path the previous stack entry is the login screen, so
  // `router.back()` would strand a freshly signed-in coach on it.
  const finish = () => {
    if (from === 'profile' && router.canGoBack()) {
      router.back();
    } else {
      router.replace(HOME_ROUTE);
    }
  };

  const handleContinue = async () => {
    if (!user || !selected) return;
    setSaving(true);
    try {
      if (selected !== user.role) {
        const response = await apiClient.patch('/auth/me/role', { role: selected });
        updateUser({ role: response.data.user.role });
      }
      await markRoleChosen(user.id);
      finish();
    } catch (err) {
      captureException(err, { flow: 'role-onboarding' });
      Alert.alert(t('roleOnboarding.errorTitle'), t('roleOnboarding.errorBody'));
    } finally {
      setSaving(false);
    }
  };

  const options: { role: Choice; icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
    {
      role: UserRole.COACH,
      icon: 'clipboard-outline',
      title: t('roleOnboarding.coachTitle'),
      body: t('roleOnboarding.coachBody'),
    },
    {
      role: UserRole.PLAYER,
      icon: 'basketball-outline',
      title: t('roleOnboarding.playerTitle'),
      body: t('roleOnboarding.playerBody'),
    },
  ];

  return (
    <ThemedView variant="background" style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.header}>
        <ThemedText variant="h1" style={styles.title}>
          {t('roleOnboarding.title')}
        </ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          {t('roleOnboarding.subtitle')}
        </ThemedText>
      </View>

      <View style={styles.options}>
        {options.map((opt) => {
          const active = selected === opt.role;
          return (
            <TouchableOpacity
              key={opt.role}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.title}
              onPress={() => setSelected(opt.role)}
              activeOpacity={0.85}
              style={[
                styles.option,
                {
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primary + '14' : colors.backgroundSecondary,
                },
              ]}
            >
              <View style={[styles.optionIcon, { backgroundColor: colors.primary + '20' }]}>
                <Ionicons name={opt.icon} size={28} color={colors.primary} />
              </View>
              <View style={styles.optionText}>
                <ThemedText variant="h4">{opt.title}</ThemedText>
                <ThemedText variant="caption" color="textSecondary">
                  {opt.body}
                </ThemedText>
              </View>
              <Ionicons
                name={active ? 'radio-button-on' : 'radio-button-off'}
                size={22}
                color={active ? colors.primary : colors.textTertiary}
              />
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Button
          title={t('roleOnboarding.continue')}
          onPress={handleContinue}
          disabled={!selected || saving}
          loading={saving}
        />
        <ThemedText variant="caption" color="textTertiary" style={styles.hint}>
          {t('roleOnboarding.hint')}
        </ThemedText>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  header: {
    marginBottom: spacing.xl,
  },
  title: {
    marginBottom: spacing.sm,
  },
  subtitle: {
    lineHeight: 22,
  },
  options: {
    flex: 1,
    gap: spacing.md,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 2,
    borderRadius: borderRadius.lg,
  },
  optionIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  footer: {
    gap: spacing.sm,
  },
  hint: {
    textAlign: 'center',
  },
});
