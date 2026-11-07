/**
 * Display-name prompt and editor.
 *
 * Accounts provisioned without a real name carry `name = email local part` —
 * guardian invites (docs/plans/parent-role-spec.md) and plain WorkOS sign-ups
 * where AuthKit collected no name. After the first sign-in `postLoginRoute`
 * sends such users here once (`utils/role-onboarding.ts#needsNamePrompt`);
 * skipping keeps the placeholder and never asks again. The screen is also
 * reachable any time from Profile → Account → Name (`?from=profile`), which
 * pre-fills the current name and pops back on save. Either way the name is
 * saved through `PATCH /auth/me { name }`.
 */

import React, { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Button, Input } from '../../components';
import { useAuthUser } from '../../store/auth-store';
import { useUpdateProfile } from '../../hooks/useProfile';
import { captureException } from '../../services/sentry';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';
import { isGuardian } from '../../utils/guardian';
import { markNameAsked, hasPlaceholderName, postLoginRoute, HOME_ROUTE } from '../../utils/role-onboarding';
import { spacing } from '../../theme';
import { useTranslation } from '../../i18n';

export default function NamePromptScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const insets = useSafeAreaInsets();
  const user = useAuthUser();
  const updateProfile = useUpdateProfile();
  const fromProfile = from === 'profile';
  // Pre-fill an existing real name for edits; never pre-fill the placeholder.
  const [name, setName] = useState(
    fromProfile && user?.name && !hasPlaceholderName(user) ? user.name : ''
  );
  const [error, setError] = useState<string | undefined>();

  // Only the Profile path may pop back: on the first-login path the previous
  // stack entry is the login screen (same rule as onboarding/role). The
  // onboarding path re-resolves postLoginRoute (the nameAsked flag is set by
  // then) so a pending invite deep link is honoured instead of dropped.
  const close = async () => {
    if (fromProfile) {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace(HOME_ROUTE);
      }
      return;
    }
    router.replace(await postLoginRoute(user));
  };

  const finish = async () => {
    if (user) await markNameAsked(user.id);
    await close();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError(t('nameOnboarding.required'));
      return;
    }
    setError(undefined);
    try {
      await updateProfile.mutateAsync({ name: trimmed });
      // The Profile path is an edit (`profile_updated`); only first-login counts as a step.
      if (!fromProfile) trackEvent(AnalyticsEvents.ONBOARDING_STEP_COMPLETED, { step: 'name' });
      await finish();
    } catch (err) {
      captureException(err, { flow: 'name-onboarding' });
      Alert.alert(t('nameOnboarding.saveFailedTitle'), t('nameOnboarding.saveFailedBody'));
    }
  };

  const subtitle = fromProfile
    ? t('nameOnboarding.subtitleEdit')
    : isGuardian(user)
      ? t('nameOnboarding.subtitleGuardian')
      : t('nameOnboarding.subtitleNew');

  return (
    <ThemedView variant="background" style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.header}>
        <ThemedText variant="h1" heading style={styles.title}>
          {fromProfile ? t('nameOnboarding.titleEdit') : t('nameOnboarding.titleNew')}
        </ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          {subtitle}
        </ThemedText>
      </View>

      <Input
        label={t('nameOnboarding.label')}
        placeholder={t('nameOnboarding.placeholder')}
        value={name}
        onChangeText={(text) => {
          setName(text);
          if (error) setError(undefined);
        }}
        error={error}
        autoCapitalize="words"
        autoCorrect={false}
        testID="name-onboarding-input"
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Button
          title={fromProfile ? t('common.save') : t('roleOnboarding.continue')}
          onPress={handleSave}
          loading={updateProfile.isPending}
          disabled={updateProfile.isPending}
          fullWidth
          size="large"
        />
        {fromProfile ? (
          <Button title={t('common.cancel')} variant="outline" onPress={close} fullWidth style={styles.skip} />
        ) : (
          <Button title={t('nameOnboarding.skip')} variant="outline" onPress={finish} fullWidth style={styles.skip} />
        )}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  header: { marginBottom: spacing.xl },
  title: { marginBottom: spacing.sm },
  subtitle: {},
  footer: { marginTop: 'auto', gap: spacing.sm },
  skip: { marginTop: spacing.xs },
});
