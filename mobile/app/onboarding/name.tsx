/**
 * One-time display-name prompt for guardian-created accounts.
 *
 * A coach's "Invite a parent" creates the adult's account with
 * `name = email local part` (PARENT role — docs/plans/parent-role-spec.md).
 * After the first sign-in `postLoginRoute` sends such users here once
 * (`utils/role-onboarding.ts#needsNamePrompt`); the name is saved through
 * `PATCH /auth/me { name }`. Skipping keeps the placeholder and never asks again.
 */

import React, { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Button, Input } from '../../components';
import { useAuthUser } from '../../store/auth-store';
import { useUpdateProfile } from '../../hooks/useProfile';
import { captureException } from '../../services/sentry';
import { markNameAsked, HOME_ROUTE } from '../../utils/role-onboarding';
import { spacing } from '../../theme';

export default function NamePromptScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAuthUser();
  const updateProfile = useUpdateProfile();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  const finish = async () => {
    if (user) await markNameAsked(user.id);
    router.replace(HOME_ROUTE);
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

  return (
    <ThemedView variant="background" style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.header}>
        <ThemedText variant="h1" style={styles.title}>
          What should we call you?
        </ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          Your coach set up this account for you. Pick the name your child&apos;s team will see.
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
          title="Continue"
          onPress={handleSave}
          loading={updateProfile.isPending}
          disabled={updateProfile.isPending}
          fullWidth
          size="large"
        />
        <Button title="Skip for now" variant="outline" onPress={finish} fullWidth style={styles.skip} />
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
