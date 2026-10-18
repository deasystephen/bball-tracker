/**
 * Player guardians screen — list a roster player's parents/guardians and
 * pending invites, invite a new one by email, remove (PARENT role —
 * docs/plans/parent-role-spec.md, role matrix decision 1).
 *
 * Readable by roster managers and by the player's own guardians (the API
 * strips `email` for guardians). Invite / remove-others / Resend render only
 * with `canManageRoster`; a guardian always gets "Leave" on their own row. The
 * API remains the authority (403 / 400 / 429).
 *
 * Resend (#420) is the invite call with `supersede: true`: the server expires
 * the pending invitation and mails a fresh link, so the old one dies.
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  ListItem,
  LoadingSpinner,
  ErrorState,
  EmptyState,
  Card,
} from '../../../../../components';
import { useToast } from '../../../../../components/Toast';
import { useTeam, hasTeamPermission } from '../../../../../hooks/useTeams';
import {
  usePlayerGuardians,
  useInviteGuardian,
  useRemoveGuardian,
  type GuardianRow,
  type PendingGuardianInvitation,
} from '../../../../../hooks/useGuardians';
import { useTheme } from '../../../../../hooks/useTheme';
import { useTranslation } from '../../../../../i18n';
import { spacing } from '../../../../../theme';
import { getHorizontalPadding } from '../../../../../utils/responsive';
import { useAuthUser } from '../../../../../store/auth-store';
import { getApiErrorMessage } from '../../../../../services/api-client';
import { relationshipLabel } from '../../../../../utils/guardian';
import { RelationshipChips } from '../../../../../components/RelationshipChips';
import type { GuardianRelationship } from '../../../../../../shared/types';
import { useGoBack } from '../../../../../hooks/useGoBack';
import { displayName } from '../../../../../utils/display-name';
import { MIN_TOUCH_TARGET } from '../../../../../utils/touch-target';
import { BackButton } from '../../../../../components/BackButton';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function PlayerGuardiansScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/teams');
  const { id, playerId } = useLocalSearchParams<{ id: string; playerId: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const user = useAuthUser();

  const { data: team, isLoading: teamLoading, error: teamError, refetch: refetchTeam } = useTeam(id);
  const {
    data: guardianList,
    isLoading: guardiansLoading,
    error: guardiansError,
    refetch: refetchGuardians,
  } = usePlayerGuardians(id, playerId);
  // One hook for Invite and Resend (the same call; Resend adds `supersede`).
  // Pending state is tracked per action: `inviting` drives the form button,
  // `resendingIds` the row in flight (spinner, taps ignored), so neither
  // action's pending state leaks into the other's controls.
  const inviteGuardian = useInviteGuardian();
  const removeGuardian = useRemoveGuardian();
  const [inviting, setInviting] = useState(false);
  const [resendingIds, setResendingIds] = useState<ReadonlySet<string>>(() => new Set());

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [relationship, setRelationship] = useState<GuardianRelationship>('GUARDIAN');

  const canManage = hasTeamPermission(team, user?.id, 'canManageRoster', user?.role, user?.leagueAdminOf);
  const member = team?.members?.find((m) => m.playerId === playerId);
  const playerName = displayName(member?.player) || 'Player';

  const handleInvite = async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setEmailError(t('common.invalidEmail'));
      return;
    }
    setEmailError(undefined);
    setInviting(true);
    try {
      const result = await inviteGuardian.mutateAsync({
        teamId: id,
        playerId,
        data: { email: trimmed, relationship },
      });
      // The pending row exists server-side either way, so the form closes in
      // both branches; a failed send is reported, never shown as "sent".
      setEmail('');
      setShowForm(false);
      if (result.emailSent === false) {
        toast.showToast(t('guardians.inviteEmailFailed', { email: trimmed }), 'error');
      } else {
        toast.showToast(t('guardians.sent', { email: trimmed }), 'success');
      }
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('guardians.inviteFailed')), 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleResend = async (invite: PendingGuardianInvitation) => {
    if (resendingIds.has(invite.id)) return;
    setResendingIds((ids) => new Set(ids).add(invite.id));
    try {
      const result = await inviteGuardian.mutateAsync({
        teamId: id,
        playerId,
        data: { email: invite.invitedEmail, relationship: invite.relationship, supersede: true },
      });
      if (result.emailSent === false) {
        toast.showToast(t('guardians.resentEmailFailed', { email: invite.invitedEmail }), 'error');
      } else {
        toast.showToast(t('guardians.resent', { email: invite.invitedEmail }), 'success');
      }
    } catch (err) {
      // 429 resend_cooldown and the lost-race 400 carry their own message.
      toast.showToast(getApiErrorMessage(err, t('guardians.resendFailed')), 'error');
    } finally {
      setResendingIds((ids) => {
        const next = new Set(ids);
        next.delete(invite.id);
        return next;
      });
    }
  };

  const handleRemove = (row: GuardianRow, isSelf: boolean) => {
    Alert.alert(
      isSelf ? 'Leave' : 'Remove guardian',
      isSelf
        ? `Stop being ${playerName}'s ${relationshipLabel(row.relationship).toLowerCase()}?`
        : `Remove ${displayName(row)} as ${playerName}'s ${relationshipLabel(row.relationship).toLowerCase()}?`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: isSelf ? 'Leave' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeGuardian.mutateAsync({ teamId: id, playerId, guardianUserId: row.userId });
              toast.showToast(isSelf ? 'You are no longer a guardian' : 'Guardian removed', 'success');
              if (isSelf) router.replace('/(tabs)/profile');
            } catch (err) {
              toast.showToast(getApiErrorMessage(err, 'Failed to remove guardian'), 'error');
            }
          },
        },
      ]
    );
  };

  if (teamLoading || guardiansLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const error = teamError ?? guardiansError;
  if (error || !team || !guardianList) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Player not found'}
        onRetry={() => {
          refetchTeam();
          refetchGuardians();
        }}
        onBack={goBack}
      />
    );
  }

  const { guardians, pendingInvitations } = guardianList;

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.topHeader,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: padding,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading>Parents &amp; guardians</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {playerName} · {team.name}
          </ThemedText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { padding, paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {canManage && (
          <Card variant="elevated" style={styles.formCard}>
            {showForm ? (
              <>
                <ThemedText variant="h4" heading style={styles.formTitle}>
                  Invite a parent
                </ThemedText>
                <Input
                  label="Parent email"
                  placeholder="parent@example.com"
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    if (emailError) setEmailError(undefined);
                  }}
                  error={emailError}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="guardian-email-input"
                />
                <ThemedText variant="captionBold" style={styles.relationshipLabel}>
                  Relationship
                </ThemedText>
                <RelationshipChips value={relationship} onChange={setRelationship} />
                <View style={styles.actionButtons}>
                  <Button
                    title={t('common.cancel')}
                    onPress={() => {
                      setShowForm(false);
                      setEmail('');
                      setEmailError(undefined);
                    }}
                    variant="outline"
                    style={styles.actionButton}
                  />
                  <Button
                    title="Send invite"
                    onPress={handleInvite}
                    loading={inviting}
                    disabled={inviting}
                    style={styles.actionButton}
                    testID="guardian-invite-submit"
                  />
                </View>
              </>
            ) : (
              <Button title="Invite a parent" onPress={() => setShowForm(true)} />
            )}
          </Card>
        )}

        <View style={styles.sectionHeader}>
          <ThemedText variant="h3" heading>Guardians</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {guardians.length}
          </ThemedText>
        </View>

        {guardians.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title="No guardians yet"
            message={canManage ? 'Invite a parent so they can see the schedule and RSVP.' : undefined}
          />
        ) : (
          guardians.map((row) => {
            const isSelf = row.userId === user?.id;
            const showRemove = canManage || isSelf;
            const subtitle = [
              relationshipLabel(row.relationship) + (row.isPrimary ? ' · Primary' : ''),
              row.email,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <ListItem
                key={row.id}
                title={isSelf ? `${displayName(row)} (${t('teams.you')})` : displayName(row)}
                subtitle={subtitle}
                accessibilityLabel={`${displayName(row)}, ${relationshipLabel(row.relationship)}`}
                rightElement={
                  showRemove ? (
                    <TouchableOpacity
                      onPress={() => handleRemove(row, isSelf)}
                      style={styles.rowButton}
                      accessibilityRole="button"
                      accessibilityLabel={isSelf ? 'Leave' : `Remove guardian: ${displayName(row)}`}
                    >
                      <Ionicons
                        name={isSelf ? 'exit-outline' : 'person-remove-outline'}
                        size={22}
                        color={colors.error}
                      />
                    </TouchableOpacity>
                  ) : undefined
                }
              />
            );
          })
        )}

        {pendingInvitations.length > 0 && (
          <>
            <View style={[styles.sectionHeader, styles.pendingHeader]}>
              <ThemedText variant="h3" heading>Pending invites</ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {pendingInvitations.length}
              </ThemedText>
            </View>
            {pendingInvitations.map((invite) => {
              const resending = resendingIds.has(invite.id);
              return (
                <ListItem
                  key={invite.id}
                  title={invite.invitedEmail}
                  subtitle={`${relationshipLabel(invite.relationship)} · Pending`}
                  leftElement={<Ionicons name="mail-outline" size={20} color={colors.textTertiary} />}
                  rightElement={
                    // Resend expires only this team's row (the API scopes the
                    // supersede to the caller's team); another team-season's
                    // pending row (e.g. last season's Team after rollover) is
                    // listed without the action.
                    canManage && invite.teamId === id ? (
                      <TouchableOpacity
                        onPress={() => handleResend(invite)}
                        style={styles.rowButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('guardians.resendA11y', { email: invite.invitedEmail })}
                        accessibilityState={{ disabled: resending, busy: resending }}
                        disabled={resending}
                        testID={`guardian-resend-${invite.id}`}
                      >
                        {resending ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.primary}
                            testID={`guardian-resending-${invite.id}`}
                          />
                        ) : (
                          <Ionicons name="refresh-outline" size={22} color={colors.primary} />
                        )}
                      </TouchableOpacity>
                    ) : undefined
                  }
                />
              );
            })}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { marginRight: spacing.sm },
  headerContent: { flex: 1 },
  scrollContent: { paddingTop: spacing.lg },
  formCard: { marginBottom: spacing.lg },
  formTitle: { marginBottom: spacing.md },
  relationshipLabel: { marginTop: spacing.sm, marginBottom: spacing.xs },
  actionButtons: { flexDirection: 'row', gap: spacing.sm },
  actionButton: { flex: 1 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  pendingHeader: { marginTop: spacing.lg },
  // Change-role and remove sit 4pt apart, so they grow to 44pt rather than
  // take hitSlop (overlapping slop would hand one the other's taps).
  rowButton: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
