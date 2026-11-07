/**
 * Create League screen
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
} from '../../../components';
import { useToast } from '../../../components/Toast';
import { useCreateLeague } from '../../../hooks/useLeagues';
import { useTheme } from '../../../hooks/useTheme';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { canCreateLeagues } from '../../../utils/team-permissions';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { BackButton } from '../../../components/BackButton';
import { useTranslation } from '../../../i18n';

export default function CreateLeagueScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [errors, setErrors] = useState<{ name?: string }>({});

  const createLeague = useCreateLeague();
  const toast = useToast();

  // League create is system-ADMIN only (league admins manage seasons, not
  // leagues). Deep links can still land here, so guard at screen level.
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user,
    canCreateLeagues(user),
    t('leagues.createNotAllowed'),
    { fallback: '/admin' }
  );

  const validate = (): boolean => {
    const newErrors: { name?: string } = {};

    if (!name.trim()) {
      newErrors.name = t('leagues.nameRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    try {
      const league = await createLeague.mutateAsync({
        name: name.trim(),
      });

      toast.showToast(t('leagues.createSuccess'), 'success');
      router.replace(`/admin/leagues/${league.id}`);
    } catch (error) {
      Alert.alert(
        t('common.error'),
        error instanceof Error ? error.message : t('leagues.createFailed')
      );
    }
  };

  if (!allowed) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: padding,
            paddingBottom: spacing.md,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading>{t('leagues.create')}</ThemedText>
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { padding, paddingBottom: insets.bottom + spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText variant="body" color="textSecondary" style={styles.description}>
            {t('leagues.createDescription')}
          </ThemedText>

          <Input
            label={t('leagues.name')}
            testID="league-name-input"
            placeholder={t('leagues.namePlaceholder')}
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            autoFocus
          />

          <View style={styles.buttonContainer}>
            <Button
              title={t('leagues.create')}
              testID="league-create-submit"
              onPress={handleSubmit}
              loading={createLeague.isPending}
              disabled={!name.trim()}
              fullWidth
            />
            <Button
              title={t('common.cancel')}
              variant="outline"
              onPress={() => router.back()}
              style={styles.cancelButton}
              fullWidth
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  description: {
    marginBottom: spacing.lg,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
