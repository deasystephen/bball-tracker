/**
 * Deep-link handler for bball-tracker://invite/<token>
 * Also handles Universal Link https://capyhoops.com/invite/<token> when the app is installed.
 */

import React from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ThemedView, ThemedText, LoadingSpinner, Button, Card } from '../../components';
import { useToast } from '../../components/Toast';
import { useTheme } from '../../hooks/useTheme';
import { useAuthStore } from '../../store/auth-store';
import { useInvitationByToken, isGuardianInvitation } from '../../hooks/useInvitationByToken';
import { relationshipLabel } from '../../utils/guardian';
import { apiClient } from '../../services/api-client';
import type { User } from '../../../shared/types';
import { useAcceptInvitation } from '../../hooks/useInvitations';
import { setPendingReturnPath } from '../../utils/return-path';
import { spacing } from '../../theme';
import { Ionicons } from '@expo/vector-icons';
import { AxiosError } from 'axios';

export default function InviteDeepLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const { isAuthenticated, updateUser } = useAuthStore();

  const { data: invitation, isLoading, error } = useInvitationByToken(token);
  const acceptById = useAcceptInvitation();

  /**
   * Logged-out users must sign in first: accepting needs an identity, and the
   * authenticated tab shell has no auth guard of its own. Remember this link so
   * `postLoginRoute` brings them straight back here after sign-in.
   */
  async function goToLogin() {
    if (token) await setPendingReturnPath(`/invite/${token}`);
    router.push('/login');
  }

  const isExpired =
    invitation?.status === 'EXPIRED' ||
    (invitation?.expiresAt != null && new Date(invitation.expiresAt) < new Date());

  const isPending = invitation?.status === 'PENDING' && !isExpired;

  // Guardian (PARENT role) invitations have no team of their own; describe
  // them by the child instead (docs/plans/parent-role-spec.md).
  const guardian = isGuardianInvitation(invitation) ? invitation : null;
  const teamInvite = invitation && !isGuardianInvitation(invitation) ? invitation : null;
  const subject = guardian
    ? `${guardian.childName}${guardian.teamName ? ` (${guardian.teamName})` : ''}`
    : invitation?.teamName ?? '';

  function formatExpiry(expiresAt: string) {
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  async function handleAccept() {
    if (!invitation || !token) return;

    if (!isAuthenticated) {
      await goToLogin();
      return;
    }

    const doAccept = async () => {
      try {
        await acceptById.mutateAsync(invitation.id);
        if (guardian) {
          // Pull the new `guardianOf` so Profile → "My kids" shows up now.
          try {
            const me = await apiClient.get<{ success: boolean; user: Partial<User> }>('/auth/me');
            if (me.data?.user?.guardianOf) {
              updateUser({ guardianOf: me.data.user.guardianOf, role: me.data.user.role });
            }
          } catch {
            // useSessionRefresh catches up on the next foreground.
          }
          toast.showToast(`You are now ${guardian.childName}'s ${relationshipLabel(guardian.relationship).toLowerCase()}`, 'success');
          router.replace('/(tabs)/profile');
          return;
        }
        toast.showToast(`You've joined ${invitation.teamName}!`, 'success');
        router.replace('/(tabs)/invitations');
      } catch (err) {
        const msg =
          err instanceof AxiosError
            ? (err.response?.data as { error?: string })?.error ?? err.message
            : 'Failed to accept invitation';
        toast.showToast(msg, 'error');
      }
    };

    Alert.alert(
      'Accept Invitation',
      guardian
        ? `Become ${guardian.childName}'s ${relationshipLabel(guardian.relationship).toLowerCase()}?`
        : `Join ${invitation.teamName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: doAccept },
      ]
    );
  }

  if (isLoading) {
    return <LoadingSpinner message="Loading invitation…" fullScreen />;
  }

  if (error || !invitation) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="close-circle-outline" size={64} color={colors.error} />
          <ThemedText variant="h2" style={styles.title}>Invitation Not Found</ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            This invitation link is invalid or has been removed.
          </ThemedText>
          <Button title="Go Home" onPress={() => router.replace('/')} style={styles.btn} />
        </View>
      </ThemedView>
    );
  }

  if (invitation.status === 'ACCEPTED') {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="checkmark-circle-outline" size={64} color={colors.success} />
          <ThemedText variant="h2" style={styles.title}>Already Accepted</ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            You&apos;ve already accepted the invitation{guardian ? ' for' : ' to'} {subject}.
          </ThemedText>
          <Button
            title="View Invitations"
            onPress={() => router.replace('/(tabs)/invitations')}
            style={styles.btn}
          />
        </View>
      </ThemedView>
    );
  }

  if (invitation.status === 'REJECTED') {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="close-circle-outline" size={64} color={colors.error} />
          <ThemedText variant="h2" style={styles.title}>Invitation Declined</ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            This invitation{guardian ? ' for' : ' to'} {subject} was declined.
          </ThemedText>
          <Button title="Go Home" onPress={() => router.replace('/')} style={styles.btn} />
        </View>
      </ThemedView>
    );
  }

  if (invitation.status === 'CANCELLED') {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="ban-outline" size={64} color={colors.textTertiary} />
          <ThemedText variant="h2" style={styles.title}>Invitation Cancelled</ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            This invitation{guardian ? ' for' : ' to'} {subject} has been cancelled.
          </ThemedText>
          <Button title="Go Home" onPress={() => router.replace('/')} style={styles.btn} />
        </View>
      </ThemedView>
    );
  }

  if (isExpired) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="time-outline" size={64} color={colors.warning} />
          <ThemedText variant="h2" style={styles.title}>Invitation Expired</ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            This invitation{guardian ? ' for' : ' to'} {subject} expired on{' '}
            {formatExpiry(invitation.expiresAt)}.
          </ThemedText>
          <ThemedText variant="caption" color="textTertiary" style={styles.hint}>
            Ask the team coach to send a new invitation.
          </ThemedText>
          <Button title="Go Home" onPress={() => router.replace('/')} style={styles.btn} />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      <View style={styles.content}>
        <Ionicons name={guardian ? 'people-outline' : 'mail-open-outline'} size={64} color={colors.primary} />
        <ThemedText variant="h1" style={styles.title}>
          {guardian ? 'Parent Invitation' : 'Team Invitation'}
        </ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          {guardian
            ? `You've been invited to be ${guardian.childName}'s ${relationshipLabel(guardian.relationship).toLowerCase()}.`
            : "You've been invited to join a team!"}
        </ThemedText>

        <Card variant="elevated" style={styles.detailCard}>
          {guardian ? (
            <>
              <DetailRow label="Child" value={guardian.childName} />
              <DetailRow label="Relationship" value={relationshipLabel(guardian.relationship)} />
              {guardian.teamName != null && <DetailRow label="Team" value={guardian.teamName} />}
            </>
          ) : (
            <DetailRow label="Team" value={teamInvite?.teamName ?? ''} />
          )}
          <DetailRow label="From" value={invitation.inviterName} />
          {teamInvite?.position != null && (
            <DetailRow label="Position" value={teamInvite.position} />
          )}
          {teamInvite?.jerseyNumber != null && (
            <DetailRow label="Jersey" value={`#${teamInvite.jerseyNumber}`} />
          )}
          <DetailRow label="Expires" value={formatExpiry(invitation.expiresAt)} />
        </Card>

        {teamInvite?.message != null && (
          <ThemedText variant="body" color="textSecondary" style={styles.message}>
            &ldquo;{teamInvite.message}&rdquo;
          </ThemedText>
        )}

        {isPending && (
          <>
            {!isAuthenticated && (
              <ThemedText variant="caption" color="textSecondary" style={styles.hint}>
                {guardian
                  ? 'Log in to accept this invitation.'
                  : 'Log in to accept this invitation and join the team.'}
              </ThemedText>
            )}
            <Button
              title={
                isAuthenticated
                  ? guardian
                    ? `Accept for ${guardian.childName}`
                    : 'Accept Invitation'
                  : 'Log In to Accept'
              }
              onPress={handleAccept}
              loading={acceptById.isPending}
              style={styles.btn}
              fullWidth
            />
          </>
        )}
      </View>
    </ThemedView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.detailRow}>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.detailLabel}>
        {label}
      </ThemedText>
      <ThemedText variant="body" style={{ color: colors.text }}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  subtitle: {
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  detailCard: {
    width: '100%',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  message: {
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  btn: {
    marginTop: spacing.md,
    width: '100%',
  },
  btnSecondary: {
    marginTop: spacing.sm,
    width: '100%',
  },
  hint: {
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
});
