/**
 * Create Season screen
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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  LoadingSpinner,
  SeasonDateFields,
} from '../../../components';
import { useToast } from '../../../components/Toast';
import { useLeague } from '../../../hooks/useLeagues';
import { useCreateSeason } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { canManageLeague } from '../../../utils/team-permissions';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { BackButton } from '../../../components/BackButton';
import { useTranslation } from '../../../i18n';

export default function CreateSeasonScreen() {
  const router = useRouter();
  const { leagueId } = useLocalSearchParams<{ leagueId: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [errors, setErrors] = useState<{ name?: string; leagueId?: string }>({});

  const { data: league, isLoading: leagueLoading } = useLeague(leagueId || '');
  const createSeason = useCreateSeason();
  const toast = useToast();

  // Season create needs system ADMIN or admin of *this* league
  // (backend `season-service.createSeason` → `isLeagueAdmin`).
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user,
    canManageLeague(user, leagueId),
    t('seasons.createNotAllowed'),
    { fallback: '/admin' }
  );

  const validate = (): boolean => {
    const newErrors: { name?: string; leagueId?: string } = {};

    if (!name.trim()) {
      newErrors.name = t('seasons.nameRequired');
    }

    if (!leagueId) {
      newErrors.leagueId = t('seasons.leagueRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate() || !leagueId) return;

    try {
      await createSeason.mutateAsync({
        leagueId,
        name: name.trim(),
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString(),
      });

      toast.showToast(t('seasons.createSuccess'), 'success');
      router.back();
    } catch (error) {
      Alert.alert(
        t('common.error'),
        error instanceof Error ? error.message : t('seasons.createFailed')
      );
    }
  };

  if (leagueLoading || !allowed) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (!leagueId || !league) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.md, paddingHorizontal: padding }]}>
          <BackButton onPress={() => router.back()} style={styles.backButton} />
          <ThemedText variant="h2" heading>{t('seasons.createTitle')}</ThemedText>
        </View>
        <View style={styles.errorContainer}>
          <ThemedText variant="body" color="error">
            {t('seasons.noLeagueSelected')}
          </ThemedText>
          <Button
            title={t('seasons.noLeagueBack')}
            variant="outline"
            onPress={() => router.back()}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </ThemedView>
    );
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
          <ThemedText variant="h2" heading>{t('seasons.createTitle')}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {t('seasons.forLeague', { league: league.name })}
          </ThemedText>
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
          <Input
            label={t('seasons.name')}
            placeholder={t('seasons.namePlaceholder')}
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            autoFocus
          />

          <SeasonDateFields
            startDate={startDate}
            endDate={endDate}
            onChangeStart={setStartDate}
            onChangeEnd={setEndDate}
          />

          <View style={styles.buttonContainer}>
            <Button
              title={t('seasons.createTitle')}
              onPress={handleSubmit}
              loading={createSeason.isPending}
              disabled={!name.trim()}
              fullWidth
              testID="season-create-submit"
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
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
