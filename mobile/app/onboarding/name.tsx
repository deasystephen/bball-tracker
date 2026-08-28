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
import { isGuardian } from '../../utils/guardian';
import { markNameAsked, hasPlaceholderName, HOME_ROUTE } from '../../utils/role-onboarding';
import { spacing } from '../../theme';

export default function NamePromptScreen() {
  const router = useRouter();
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
  // stack entry is the login screen (same rule as onboarding/role).
  const close = () => {
    if (fromProfile && router.canGoBack()) {
      router.back();
    } else {
      router.replace(HOME_ROUTE);
    }
  };

  const finish = async () => {
    if (user) await markNameAsked(user.id);
    close();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Please enter your name');
      return;
    }
    setError(undefined);
    try {
      await updateProfile.mutateAsync({ name: trimmed });
      await finish();
    } catch (err) {
      captureException(err, { flow: 'name-onboarding' });
      Alert.alert('Could not save', 'Please try again.');
    }
  };

  const subtitle = fromProfile
    ? 'This is the name your teammates, coaches and leagues see.'
    : isGuardian(user)
      ? "Your coach set up this account for you. Pick the name your child's team will see."
      : 'Your account does not have a display name yet. Add the one your teams should see.';

  return (
    <ThemedView variant="background" style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.header}>
        <ThemedText variant="h1" style={styles.title}>
          {fromProfile ? 'Edit your name' : 'What should we call you?'}
        </ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          {subtitle}
        </ThemedText>
      </View>

      <Input
        label="Your name"
        placeholder="e.g. Dell Curry"
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
          title={fromProfile ? 'Save' : 'Continue'}
          onPress={handleSave}
          loading={updateProfile.isPending}
          disabled={updateProfile.isPending}
          fullWidth
          size="large"
        />
        {fromProfile ? (
          <Button title="Cancel" variant="outline" onPress={close} fullWidth style={styles.skip} />
        ) : (
          <Button title="Skip for now" variant="outline" onPress={finish} fullWidth style={styles.skip} />
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
