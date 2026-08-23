/**
 * Player guardians screen — list a roster player's parents/guardians and
 * pending invites, invite a new one by email, remove (PARENT role —
 * docs/plans/parent-role-spec.md, role matrix decision 1).
 *
 * Readable by roster managers and by the player's own guardians (the API
 * strips `email` for guardians). Invite / remove-others render only with
 * `canManageRoster`; a guardian always gets "Leave" on their own row. The
 * API remains the authority (403 / 400).
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
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
} from '../../../../../hooks/useGuardians';
import { useTheme } from '../../../../../hooks/useTheme';
import { useTranslation } from '../../../../../i18n';
import { spacing, borderRadius } from '../../../../../theme';
import { getHorizontalPadding } from '../../../../../utils/responsive';
import { useAuthUser } from '../../../../../store/auth-store';
import { getApiErrorMessage } from '../../../../../services/api-client';
import { GUARDIAN_RELATIONSHIPS, relationshipLabel } from '../../../../../utils/guardian';
import type { GuardianRelationship } from '../../../../../../shared/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function PlayerGuardiansScreen() {
  const router = useRouter();
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
  const inviteGuardian = useInviteGuardian();
  const removeGuardian = useRemoveGuardian();

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [relationship, setRelationship] = useState<GuardianRelationship>('GUARDIAN');

  const canManage = hasTeamPermission(team, user?.id, 'canManageRoster', user?.role, user?.leagueAdminOf);
  const member = team?.members?.find((m) => m.playerId === playerId);
  const playerName = member?.player.name ?? 'Player';

  const handleInvite = async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setEmailError(t('common.invalidEmail'));
      return;
    }
    setEmailError(undefined);
    try {
      await inviteGuardian.mutateAsync({ teamId: id, playerId, data: { email: trimmed, relationship } });
      setEmail('');
      setShowForm(false);
      toast.showToast(`Invitation sent to ${trimmed}`, 'success');
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, 'Failed to send invitation'), 'error');
    }
  };

  const handleRemove = (row: GuardianRow, isSelf: boolean) => {
    Alert.alert(
      isSelf ? 'Leave' : 'Remove guardian',
      isSelf
        ? `Stop being ${playerName}'s ${relationshipLabel(row.relationship).toLowerCase()}?`
        : `Remove ${row.name} as ${playerName}'s ${relationshipLabel(row.relationship).toLowerCase()}?`,
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
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2">Parents &amp; guardians</ThemedText>
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
                <ThemedText variant="h4" style={styles.formTitle}>
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
                <View style={styles.chipRow}>
                  {GUARDIAN_RELATIONSHIPS.map((value) => {
                    const selected = value === relationship;
                    return (
                      <TouchableOpacity
                        key={value}
                        onPress={() => setRelationship(value)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={relationshipLabel(value)}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: selected ? colors.primary : colors.backgroundSecondary,
                            borderColor: selected ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <ThemedText variant="captionBold" style={selected ? styles.chipTextSelected : undefined}>
                          {relationshipLabel(value)}
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
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
                    loading={inviteGuardian.isPending}
                    disabled={inviteGuardian.isPending}
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
          <ThemedText variant="h3">Guardians</ThemedText>
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
                title={isSelf ? `${row.name} (${t('teams.you')})` : row.name}
                subtitle={subtitle}
                accessibilityLabel={`${row.name}, ${relationshipLabel(row.relationship)}`}
                rightElement={
                  showRemove ? (
                    <TouchableOpacity
                      onPress={() => handleRemove(row, isSelf)}
                      style={styles.rowButton}
                      accessibilityRole="button"
                      accessibilityLabel={isSelf ? 'Leave' : `Remove guardian: ${row.name}`}
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
              <ThemedText variant="h3">Pending invites</ThemedText>
              <ThemedText variant="caption" color="textSecondary">
                {pendingInvitations.length}
              </ThemedText>
            </View>
            {pendingInvitations.map((invite) => (
              <ListItem
                key={invite.id}
                title={invite.invitedEmail}
                subtitle={`${relationshipLabel(invite.relationship)} · Pending`}
                leftElement={<Ionicons name="mail-outline" size={20} color={colors.textTertiary} />}
              />
            ))}
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
  backButton: { padding: spacing.sm, marginRight: spacing.sm },
  headerContent: { flex: 1 },
  scrollContent: { paddingTop: spacing.lg },
  formCard: { marginBottom: spacing.lg },
  formTitle: { marginBottom: spacing.md },
  relationshipLabel: { marginTop: spacing.sm, marginBottom: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  chipTextSelected: { color: '#FFFFFF' },
  actionButtons: { flexDirection: 'row', gap: spacing.sm },
  actionButton: { flex: 1 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  pendingHeader: { marginTop: spacing.lg },
  rowButton: { padding: spacing.xs },
});
