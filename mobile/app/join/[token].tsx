/**
 * Deep-link handler for hooplings://join/<token> (#210), and for the
 * Universal Link https://hooplings.com/join/<token> when the app is installed.
 *
 * A team join link names nobody, so opening it only lets a signed-in adult
 * ASK to join: as a player themself, or for their child (who becomes a roster
 * record the parent is linked to, never a login). A coach approves the
 * request; until then nothing about the team but its name is shown.
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  LoadingSpinner,
  Button,
  Card,
  ErrorState,
  Input,
  RelationshipChips,
  SortPills,
} from '../../components';
import { useToast } from '../../components/Toast';
import { useTheme } from '../../hooks/useTheme';
import { useGoBack } from '../../hooks/useGoBack';
import { useQueryErrorState } from '../../hooks/useQueryErrorState';
import { useJoinLinkPreview, useRequestToJoin, type JoinRequestResult } from '../../hooks/useJoinLink';
import { getApiErrorMessage, isRateLimitedError, isTransientRequestError } from '../../services/api-client';
import { useIsAuthenticated } from '../../store/auth-store';
import { setPendingReturnPath } from '../../utils/return-path';
import { useTranslation } from '../../i18n';
import { spacing } from '../../theme';
import type { GuardianRelationship } from '../../../shared/types';

type JoinAs = 'self' | 'child';

export default function JoinDeepLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const { t } = useTranslation();
  const goBack = useGoBack('/');
  const isAuthenticated = useIsAuthenticated();

  const { data: link, isLoading, error, refetch } = useJoinLinkPreview(token);
  // Only a transient failure is retryable; a 400/404 is the dead-link screen.
  const transientError = error && isTransientRequestError(error) ? error : null;
  const loadState = useQueryErrorState({ error: transientError, data: link, refetch }, t('join.loadFailedShort'));
  const requestToJoin = useRequestToJoin();

  const [joinAs, setJoinAs] = useState<JoinAs | null>(null);
  const [childName, setChildName] = useState('');
  const [relationship, setRelationship] = useState<GuardianRelationship>('MOTHER');
  const [sent, setSent] = useState<Extract<JoinRequestResult, { status: 'pending' }> | null>(null);

  /**
   * Asking needs an identity. Remember this link so `postLoginRoute` brings
   * the person straight back here after sign-in (and after the age screen).
   */
  async function goToLogin() {
    if (token) await setPendingReturnPath(`/join/${token}`);
    router.push('/login');
  }

  const trimmedChildName = childName.trim();
  const canSubmit = joinAs === 'self' || (joinAs === 'child' && trimmedChildName.length > 0);

  async function handleSubmit() {
    if (!token || !canSubmit) return;
    try {
      const result = await requestToJoin.mutateAsync({
        token,
        data: joinAs === 'child' ? { kind: 'child', childName: trimmedChildName, relationship } : { kind: 'self' },
      });
      if (result.status === 'already_member') {
        toast.showToast(t('join.alreadyMember', { team: result.teamName }), 'success');
        router.replace(`/teams/${result.teamId}`);
        return;
      }
      setSent(result);
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('join.requestFailed')), 'error');
      // The link may have expired, filled or been replaced meanwhile.
      void refetch();
    }
  }

  if (isLoading || loadState.retrying) {
    return <LoadingSpinner message={t('join.loading')} fullScreen />;
  }

  if (loadState.failed) {
    return (
      <ErrorState
        message={isRateLimitedError(error) ? t('invite.rateLimited') : t('join.loadFailed')}
        onRetry={loadState.retry}
        onBack={goBack}
      />
    );
  }

  if (sent) {
    return (
      <Notice
        icon="checkmark-circle-outline"
        iconColor={colors.success}
        title={t('join.sentTitle')}
        body={
          sent.created
            ? t('join.sentBody', { team: sent.teamName })
            : t('join.alreadySentBody', { team: sent.teamName })
        }
        action={{ title: t('join.done'), onPress: () => router.replace('/') }}
        secondary={
          joinAs === 'child'
            ? {
                title: t('join.addAnotherChild'),
                onPress: () => {
                  setSent(null);
                  setChildName('');
                },
              }
            : undefined
        }
      />
    );
  }

  if (error || !link) {
    return (
      <Notice
        icon="close-circle-outline"
        iconColor={colors.error}
        title={t('join.notFoundTitle')}
        body={t('join.notFoundBody')}
        action={{ title: t('invite.goHome'), onPress: () => router.replace('/') }}
      />
    );
  }

  if (link.state !== 'active') {
    return (
      <Notice
        icon="time-outline"
        iconColor={colors.warning}
        title={link.state === 'expired' ? t('join.expiredTitle') : t('join.fullTitle')}
        body={t('join.inactiveBody', { team: link.teamName })}
        action={{ title: t('invite.goHome'), onPress: () => router.replace('/') }}
      />
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Ionicons name="people-outline" size={64} color={colors.primary} />
        <ThemedText variant="h1" heading style={styles.title}>
          {t('join.title', { team: link.teamName })}
        </ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          {t('join.subtitle')}
        </ThemedText>

        {isAuthenticated ? (
          <>
            <Card variant="elevated" style={styles.formCard}>
              <ThemedText variant="captionBold" color="textSecondary" style={styles.question}>
                {t('join.whoQuestion')}
              </ThemedText>
              <SortPills
                options={[
                  { key: 'self', label: t('join.asSelf') },
                  { key: 'child', label: t('join.asChild') },
                ]}
                selected={joinAs}
                onSelect={setJoinAs}
                labelPrefix={`${t('join.whoQuestion')} `}
              />
              {joinAs === 'child' && (
                <>
                  <ThemedText variant="caption" color="textSecondary" style={styles.childNote}>
                    {t('join.childNote')}
                  </ThemedText>
                  <Input
                    label={t('join.childNameLabel')}
                    value={childName}
                    onChangeText={setChildName}
                    autoCapitalize="words"
                    autoCorrect={false}
                    maxLength={100}
                    returnKeyType="done"
                    testID="join-child-name"
                  />
                  <ThemedText variant="captionBold" color="textSecondary" style={styles.question}>
                    {t('guardians.relationshipLabel')}
                  </ThemedText>
                  <RelationshipChips value={relationship} onChange={setRelationship} />
                </>
              )}
            </Card>
            <Button
              title={t('join.submit')}
              onPress={() => void handleSubmit()}
              loading={requestToJoin.isPending}
              disabled={!canSubmit || requestToJoin.isPending}
              style={styles.btn}
              testID="join-submit"
              fullWidth
            />
          </>
        ) : (
          <>
            <ThemedText variant="caption" color="textSecondary" style={styles.hint}>
              {t('join.loginHint')}
            </ThemedText>
            <Button
              title={t('join.loginToContinue')}
              onPress={() => void goToLogin()}
              style={styles.btn}
              testID="join-login"
              fullWidth
            />
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

interface NoticeAction {
  title: string;
  onPress: () => void;
}

/** A centred icon, heading, sentence and one or two buttons: every terminal state of the screen. */
function Notice({
  icon,
  iconColor,
  title,
  body,
  action,
  secondary,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  title: string;
  body: string;
  action: NoticeAction;
  secondary?: NoticeAction;
}) {
  return (
    <ThemedView variant="background" style={styles.container}>
      <View style={styles.content}>
        <Ionicons name={icon} size={64} color={iconColor} />
        <ThemedText variant="h2" heading style={styles.title}>{title}</ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          {body}
        </ThemedText>
        <Button title={action.title} onPress={action.onPress} style={styles.btn} />
        {secondary && (
          <Button title={secondary.title} onPress={secondary.onPress} variant="outline" style={styles.btn} />
        )}
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: { textAlign: 'center', marginTop: spacing.md, marginBottom: spacing.sm },
  subtitle: { textAlign: 'center', marginBottom: spacing.lg },
  formCard: { width: '100%', marginBottom: spacing.md },
  question: { marginBottom: spacing.sm },
  childNote: { marginTop: spacing.md, marginBottom: spacing.md },
  btn: { marginTop: spacing.md, width: '100%' },
  hint: { textAlign: 'center', marginBottom: spacing.sm },
});
