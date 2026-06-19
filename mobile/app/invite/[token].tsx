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
import { useInvitationByToken, useAcceptInvitationByToken } from '../../hooks/useInvitationByToken';
import { useAcceptInvitation } from '../../hooks/useInvitations';
import { spacing } from '../../theme';
import { Ionicons } from '@expo/vector-icons';
import { AxiosError } from 'axios';

export default function InviteDeepLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const { isAuthenticated } = useAuthStore();

  const { data: invitation, isLoading, error } = useInvitationByToken(token);
  const acceptByToken = useAcceptInvitationByToken();
  const acceptById = useAcceptInvitation();

  const isExpired =
    invitation?.status === 'EXPIRED' ||
    (invitation?.expiresAt != null && new Date(invitation.expiresAt) < new Date());

  const isPending = invitation?.status === 'PENDING' && !isExpired;

  function formatExpiry(expiresAt: string) {
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  async function handleAccept() {
    if (!invitation || !token) return;

    const doAccept = async () => {
      try {
        if (isAuthenticated) {
          await acceptById.mutateAsync(invitation.id);
        } else {
          await acceptByToken.mutateAsync(token);
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
      `Join ${invitation.teamName}?`,
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
            You&apos;ve already accepted the invitation to {invitation.teamName}.
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
            This invitation to {invitation.teamName} was declined.
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
            This invitation to {invitation.teamName} has been cancelled.
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
            This invitation to {invitation.teamName} expired on{' '}
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
        <Ionicons name="mail-open-outline" size={64} color={colors.primary} />
        <ThemedText variant="h1" style={styles.title}>Team Invitation</ThemedText>
        <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
          You&apos;ve been invited to join a team!
        </ThemedText>

        <Card variant="elevated" style={styles.detailCard}>
          <DetailRow label="Team" value={invitation.teamName} />
          <DetailRow label="From" value={invitation.inviterName} />
          {invitation.position != null && (
            <DetailRow label="Position" value={invitation.position} />
          )}
          {invitation.jerseyNumber != null && (
            <DetailRow label="Jersey" value={`#${invitation.jerseyNumber}`} />
          )}
          <DetailRow label="Expires" value={formatExpiry(invitation.expiresAt)} />
        </Card>

        {invitation.message != null && (
          <ThemedText variant="body" color="textSecondary" style={styles.message}>
            &ldquo;{invitation.message}&rdquo;
          </ThemedText>
        )}

        {isPending && (
          <>
            {!isAuthenticated && (
              <ThemedText variant="caption" color="textSecondary" style={styles.hint}>
                Log in to accept this invitation and join the team.
              </ThemedText>
            )}
            <Button
              title="Accept Invitation"
              onPress={handleAccept}
              loading={acceptById.isPending || acceptByToken.isPending}
              style={styles.btn}
              fullWidth
            />
            {!isAuthenticated && (
              <Button
                title="Log In"
                variant="outline"
                onPress={() => router.push('/login')}
                style={styles.btnSecondary}
                fullWidth
              />
            )}
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
