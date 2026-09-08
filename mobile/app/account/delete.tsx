/**
 * Delete account / delete a child's record (#444, App Store 5.1.1(v)).
 *
 * Reached from Profile → Account → "Delete account" (self) or Profile → My
 * kids → ⋯ → "Delete <child>'s record" (`?childId=<id>`, guardian of a
 * managed, unclaimed child). Two taps from Profile to the confirm button.
 *
 *   plain-language summary (removed / kept)
 *   → Input "Type DELETE to confirm"   (button disabled until exact match)
 *   → destructive Button               (disabled again while pending)
 *   → self:  DELETE /auth/me  → clearSession() → toast → /login
 *     child: DELETE /players/:id/account → re-read /auth/me → toast → back
 *   ↳ 400 last_head_coach: inline list of the blocking teams (tap → team)
 *   ↳ anything else: error toast, screen stays, button re-enables
 */
import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Card, Input, Button } from '../../components';
import { useToast } from '../../components/Toast';
import { useTheme } from '../../hooks/useTheme';
import { useAuthUser } from '../../store/auth-store';
import { useDeleteAccount, useDeleteChildRecord, getLastHeadCoachTeams, type BlockingTeam } from '../../hooks/useAccount';
import { guardianChildren } from '../../utils/guardian';
import { getApiErrorMessage } from '../../services/api-client';
import { captureException } from '../../services/sentry';
import { useTranslation } from '../../i18n';
import { spacing, borderRadius } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';

/** The exact, case-sensitive confirmation word (trimmed). */
export const DELETE_CONFIRMATION = 'DELETE';

export function isConfirmed(text: string): boolean {
  return text.trim() === DELETE_CONFIRMATION;
}

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { childId } = useLocalSearchParams<{ childId?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const padding = getHorizontalPadding();
  const user = useAuthUser();
  const deleteAccount = useDeleteAccount();
  const deleteChild = useDeleteChildRecord();

  const child = childId ? guardianChildren(user).find((c) => c.childId === childId) : undefined;
  const childName = child?.childName ?? '';
  const isChild = Boolean(childId);

  const [confirmation, setConfirmation] = useState('');
  const [blockingTeams, setBlockingTeams] = useState<BlockingTeam[] | null>(null);

  const pending = deleteAccount.isPending || deleteChild.isPending;
  const canDelete = isConfirmed(confirmation) && !pending;

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/profile');
    }
  };

  const handleDelete = async () => {
    if (!canDelete) return;
    setBlockingTeams(null);
    try {
      if (isChild && childId) {
        await deleteChild.mutateAsync({ childId });
        toast.showToast(t('account.delete.childSuccessToast', { name: childName }), 'success');
        goBack();
        return;
      }
      await deleteAccount.mutateAsync();
      toast.showToast(t('account.delete.successToast'), 'success');
      router.replace('/login');
    } catch (error) {
      const teams = getLastHeadCoachTeams(error);
      if (teams) {
        setBlockingTeams(teams);
        return;
      }
      captureException(error, { flow: isChild ? 'child-record-delete' : 'account-delete' });
      toast.showToast(getApiErrorMessage(error, t('account.delete.errorToast')), 'error');
    }
  };

  const title = isChild ? t('account.delete.childTitle', { name: childName }) : t('account.delete.title');

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
        <TouchableOpacity onPress={goBack} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2">{title}</ThemedText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Card variant="default" style={styles.card}>
          <View style={styles.summaryRow}>
            <Ionicons name="trash-outline" size={20} color={colors.error} style={styles.summaryIcon} />
            <View style={styles.summaryText}>
              <ThemedText variant="bodyBold">{t('account.delete.removedTitle')}</ThemedText>
              <ThemedText variant="body" color="textSecondary">
                {isChild ? t('account.delete.childRemovedBody', { name: childName }) : t('account.delete.removedBody')}
              </ThemedText>
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.summaryRow}>
            <Ionicons name="stats-chart-outline" size={20} color={colors.textSecondary} style={styles.summaryIcon} />
            <View style={styles.summaryText}>
              <ThemedText variant="bodyBold">{t('account.delete.keptTitle')}</ThemedText>
              <ThemedText variant="body" color="textSecondary">
                {isChild ? t('account.delete.childKeptBody', { name: childName }) : t('account.delete.keptBody')}
              </ThemedText>
            </View>
          </View>
        </Card>

        {blockingTeams && (
          <Card variant="default" style={[styles.card, styles.blockingCard, { borderColor: colors.warning }]} testID="last-head-coach-block">
            <ThemedText variant="bodyBold">{t('account.delete.lastHeadCoachTitle')}</ThemedText>
            <ThemedText variant="body" color="textSecondary" style={styles.blockingBody}>
              {t('account.delete.lastHeadCoachBody')}
            </ThemedText>
            {blockingTeams.map((team) => (
              <TouchableOpacity
                key={team.id}
                style={[styles.teamRow, { borderTopColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={`Open team ${team.name}`}
                onPress={() => router.push(`/teams/${team.id}`)}
              >
                <ThemedText variant="body">{team.name}</ThemedText>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            ))}
          </Card>
        )}

        <Input
          label={t('account.delete.confirmLabel')}
          placeholder={t('account.delete.confirmPlaceholder')}
          value={confirmation}
          onChangeText={setConfirmation}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          testID="delete-confirmation-input"
        />

        <View style={styles.footer}>
          <Button
            title={isChild ? t('account.delete.childButton') : t('account.delete.button')}
            variant="danger"
            onPress={handleDelete}
            loading={pending}
            disabled={!canDelete}
            fullWidth
            testID="delete-account-submit"
            accessibilityLabel={isChild ? t('account.delete.childButton') : t('account.delete.button')}
          />
          <Button title={t('account.delete.cancel')} variant="outline" onPress={goBack} fullWidth style={styles.cancel} />
        </View>
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
  scrollContent: { paddingTop: spacing.lg },
  card: { padding: spacing.md, marginBottom: spacing.lg },
  summaryRow: { flexDirection: 'row', alignItems: 'flex-start' },
  summaryIcon: { marginRight: spacing.sm, marginTop: 2 },
  summaryText: { flex: 1, gap: spacing.xs },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.md },
  blockingCard: { borderWidth: 1, borderRadius: borderRadius.md },
  blockingBody: { marginTop: spacing.xs, marginBottom: spacing.sm },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footer: { marginTop: spacing.lg, gap: spacing.sm },
  cancel: { marginTop: spacing.xs },
});
