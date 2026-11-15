/**
 * Team staff screen — list coaches / managers, add by email, change role,
 * remove (role matrix decision 2, B2.3), and invite an address that has no
 * account yet (#460): the add answers 404, the form offers "Send invitation",
 * and pending invitations are listed with Resend and Cancel.
 *
 * Readable by anyone with team access; the mutating controls render only
 * when `canManageStaff` (ADMIN, league admin or head coach). Self-removal
 * ("Leave team") is allowed for any staff member except the last head coach.
 * The API remains the authority (403 / 400).
 */

import React, { useMemo, useState } from 'react';
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
} from '../../../components';
import { useToast } from '../../../components/Toast';
import { ActionMenu, type ActionMenuItem } from '../../../components/ActionMenu';
import { useTeam, canManageStaff } from '../../../hooks/useTeams';
import {
  useTeamStaff,
  useAddStaff,
  useUpdateStaffRole,
  useRemoveStaff,
  useStaffInvitations,
  useInviteStaff,
  useCancelStaffInvitation,
  STAFF_ROLE_TYPES,
  type StaffRoleType,
  type TeamStaffRow,
  type StaffInvitationRow,
} from '../../../hooks/useTeamStaff';
import { formatInvitationExpiry } from '../../../utils/invitation-expiry';
import { staffRoleLabel } from '../../../utils/staff-role';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { useAuthUser } from '../../../store/auth-store';
import { getApiErrorMessage } from '../../../services/api-client';
import { displayName } from '../../../utils/display-name';
import { useGoBack } from '../../../hooks/useGoBack';
import { MIN_TOUCH_TARGET } from '../../../utils/touch-target';
import { BackButton } from '../../../components/BackButton';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function TeamStaffScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/teams');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const user = useAuthUser();

  const { data: team, isLoading: teamLoading, error: teamError, refetch: refetchTeam } = useTeam(id);
  const { data: staff, isLoading: staffLoading, error: staffError, refetch: refetchStaff } = useTeamStaff(id);
  const addStaff = useAddStaff();
  const updateRole = useUpdateStaffRole();
  const removeStaff = useRemoveStaff();
  const inviteStaff = useInviteStaff();
  const cancelInvitation = useCancelStaffInvitation();

  const [showAddForm, setShowAddForm] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [roleType, setRoleType] = useState<StaffRoleType>('ASSISTANT_COACH');
  const [roleMenuRow, setRoleMenuRow] = useState<TeamStaffRow | null>(null);
  // The address the add just answered 404 for: the form then offers an invitation (#460).
  const [inviteOffer, setInviteOffer] = useState<string | null>(null);

  const canManage = canManageStaff(team, user?.id, user?.role, user?.leagueAdminOf);
  const {
    data: pendingInvitations,
    error: invitationsError,
    refetch: refetchInvitations,
  } = useStaffInvitations(id, canManage);

  const headCoachCount = useMemo(
    () => (staff ?? []).filter((s) => s.role.type === 'HEAD_COACH').length,
    [staff]
  );

  // A CUSTOM role has no label key: its own name.
  const roleLabel = (row: TeamStaffRow) => staffRoleLabel(t, row.role.type, row.role.name);

  const handleAdd = async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setEmailError(t('common.invalidEmail'));
      return;
    }
    setEmailError(undefined);
    try {
      await addStaff.mutateAsync({ teamId: id, data: { email: trimmed, roleType } });
      setEmail('');
      setShowAddForm(false);
      toast.showToast(t('teams.staffAdded'), 'success');
    } catch (err) {
      const apiError = (err as { apiError?: { status?: number; error?: string } }).apiError;
      // Only the target lookup's 404 means "no account" (a gone team is a 404 too).
      if (apiError?.status === 404 && apiError.error === 'User not found') {
        setInviteOffer(trimmed);
        return;
      }
      toast.showToast(getApiErrorMessage(err, t('teams.staffAddFailed')), 'error');
    }
  };

  const resetForm = () => {
    setShowAddForm(false);
    setEmail('');
    setEmailError(undefined);
    setInviteOffer(null);
  };

  /** Send (or, with `supersede`, re-send) a staff invitation; a failed email is never silent. */
  const sendInvitation = async (address: string, type: StaffRoleType, supersede = false) => {
    try {
      const result = await inviteStaff.mutateAsync({
        teamId: id,
        data: { email: address, roleType: type, supersede },
      });
      if (!supersede) resetForm();
      toast.showToast(
        result.emailSent ? t('teams.staffInvitationSent') : t('teams.staffInvitationEmailFailed'),
        result.emailSent ? 'success' : 'error'
      );
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('teams.staffInviteFailed')), 'error');
    }
  };

  const handleCancelInvitation = (row: StaffInvitationRow) => {
    Alert.alert(t('teams.cancelStaffInvitationTitle'), t('teams.cancelStaffInvitationMessage', { email: row.invitedEmail }), [
      { text: t('roster.keepInvitation'), style: 'cancel' },
      {
        text: t('roster.cancelInvitation'),
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelInvitation.mutateAsync({ teamId: id, invitationId: row.id });
            toast.showToast(t('teams.staffInvitationCancelled'), 'success');
          } catch (err) {
            toast.showToast(getApiErrorMessage(err, t('teams.staffInvitationCancelFailed')), 'error');
          }
        },
      },
    ]);
  };

  const changeRole = async (row: TeamStaffRow, type: StaffRoleType) => {
    if (updateRole.isPending) return;
    try {
      await updateRole.mutateAsync({ teamId: id, userId: row.userId, roleType: type });
      toast.showToast(t('teams.roleUpdated'), 'success');
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('teams.roleUpdateFailed')), 'error');
    }
  };

  // Per-row role chooser: an ActionMenu, never an Alert list (Android keeps
  // only three Alert buttons). The sheet brings its own Close item.
  const roleMenuItemsFor = (row: TeamStaffRow): ActionMenuItem[] =>
    STAFF_ROLE_TYPES.filter((type) => type !== row.role.type).map((type) => ({
      label: staffRoleLabel(t, type),
      onPress: () => void changeRole(row, type),
    }));

  const handleRemove = (row: TeamStaffRow, isSelf: boolean) => {
    Alert.alert(
      isSelf ? t('teams.leaveTeam') : t('teams.removeStaffTitle'),
      isSelf ? t('teams.leaveTeamMessage') : t('teams.removeStaffMessage', { name: displayName(row.user) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: isSelf ? t('teams.leaveTeam') : t('teams.removeStaff'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeStaff.mutateAsync({ teamId: id, userId: row.userId });
              if (isSelf) {
                toast.showToast(t('teams.leftTeam'), 'success');
                router.replace('/(tabs)/teams');
              } else {
                toast.showToast(t('teams.staffRemoved'), 'success');
              }
            } catch (err) {
              toast.showToast(getApiErrorMessage(err, t('teams.staffRemoveFailed')), 'error');
            }
          },
        },
      ]
    );
  };

  if (teamLoading || staffLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const error = teamError ?? staffError;
  if (error || !team || !staff) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('teams.notFound')}
        onRetry={() => {
          refetchTeam();
          refetchStaff();
        }}
        onBack={goBack}
      />
    );
  }

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
          <ThemedText variant="h2" heading>{t('teams.staff')}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {team.name}
          </ThemedText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { padding, paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {canManage && (
          <Card variant="elevated" style={styles.formCard}>
            {showAddForm ? (
              <>
                <ThemedText variant="h4" heading style={styles.formTitle}>
                  {t('teams.addStaff')}
                </ThemedText>
                <Input
                  label={t('teams.staffEmail')}
                  placeholder={t('teams.staffEmailPlaceholder')}
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    if (emailError) setEmailError(undefined);
                    if (inviteOffer) setInviteOffer(null);
                  }}
                  error={emailError}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="staff-email-input"
                />
                <ThemedText variant="captionBold" style={styles.roleLabel}>
                  {t('teams.staffRole')}
                </ThemedText>
                <View style={styles.roleRow}>
                  {STAFF_ROLE_TYPES.map((type) => {
                    const selected = type === roleType;
                    return (
                      <TouchableOpacity
                        key={type}
                        onPress={() => setRoleType(type)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={staffRoleLabel(t, type)}
                        style={[
                          styles.roleChip,
                          {
                            backgroundColor: selected ? colors.primary : colors.backgroundSecondary,
                            borderColor: selected ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <ThemedText
                          variant="captionBold"
                          style={selected ? styles.roleChipTextSelected : undefined}
                        >
                          {staffRoleLabel(t, type)}
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {inviteOffer !== null && (
                  <ThemedText variant="caption" color="textSecondary" style={styles.inviteHint}>
                    {t('teams.staffNoAccountInvite')}
                  </ThemedText>
                )}
                <View style={styles.actionButtons}>
                  <Button
                    title={t('common.cancel')}
                    onPress={resetForm}
                    variant="outline"
                    style={styles.actionButton}
                  />
                  {inviteOffer !== null ? (
                    <Button
                      title={t('teams.sendStaffInvitation')}
                      onPress={() => void sendInvitation(inviteOffer, roleType)}
                      loading={inviteStaff.isPending}
                      disabled={inviteStaff.isPending}
                      style={styles.actionButton}
                      testID="staff-invite-submit"
                    />
                  ) : (
                    <Button
                      title={t('teams.addStaff')}
                      onPress={handleAdd}
                      loading={addStaff.isPending}
                      disabled={addStaff.isPending}
                      style={styles.actionButton}
                      testID="staff-add-submit"
                    />
                  )}
                </View>
              </>
            ) : (
              <Button title={t('teams.addStaff')} onPress={() => setShowAddForm(true)} />
            )}
          </Card>
        )}

        <View style={styles.sectionHeader}>
          <ThemedText variant="h3" heading>{t('teams.staff')}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {t('teams.staffCount', { count: staff.length })}
          </ThemedText>
        </View>

        {staff.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title={t('teams.noStaff')}
            message={t('teams.noStaffMessage')}
          />
        ) : (
          staff.map((row) => {
            const isSelf = row.userId === user?.id;
            const isLastHeadCoach = row.role.type === 'HEAD_COACH' && headCoachCount <= 1;
            const showRemove = (canManage || isSelf) && !isLastHeadCoach;
            const subtitle = [roleLabel(row), row.user.email].filter(Boolean).join(' · ');

            return (
              <ListItem
                key={row.id}
                title={isSelf ? `${displayName(row.user)} (${t('teams.you')})` : displayName(row.user)}
                subtitle={subtitle}
                accessibilityLabel={`${displayName(row.user)}, ${roleLabel(row)}`}
                rightElement={
                  <View style={styles.rowActions}>
                    {canManage && (
                      <TouchableOpacity
                        onPress={() => setRoleMenuRow(row)}
                        style={styles.rowButton}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('teams.changeRole')}: ${displayName(row.user)}`}
                        // One role PATCH at a time: a second would race the first.
                        disabled={updateRole.isPending}
                      >
                        <Ionicons name="swap-horizontal-outline" size={22} color={colors.primary} />
                      </TouchableOpacity>
                    )}
                    {showRemove && (
                      <TouchableOpacity
                        onPress={() => handleRemove(row, isSelf)}
                        style={styles.rowButton}
                        accessibilityRole="button"
                        accessibilityLabel={
                          isSelf ? t('teams.leaveTeam') : `${t('teams.removeStaff')}: ${displayName(row.user)}`
                        }
                      >
                        <Ionicons
                          name={isSelf ? 'exit-outline' : 'person-remove-outline'}
                          size={22}
                          color={colors.error}
                        />
                      </TouchableOpacity>
                    )}
                  </View>
                }
              />
            );
          })
        )}

        {canManage && invitationsError != null && (
          <View style={styles.invitationsError}>
            <ThemedText variant="caption" color="error">
              {t('teams.staffInvitationsLoadFailed')}
            </ThemedText>
            <Button title={t('common.tryAgain')} variant="outline" size="small" onPress={() => refetchInvitations()} />
          </View>
        )}

        {canManage && pendingInvitations != null && pendingInvitations.length > 0 && (
          <>
            <View style={[styles.sectionHeader, styles.invitationsHeader]}>
              <ThemedText variant="h3" heading>{t('teams.pendingStaffInvitations')}</ThemedText>
            </View>
            {pendingInvitations.map((row) => (
              <ListItem
                key={row.id}
                title={row.invitedEmail}
                subtitle={`${staffRoleLabel(t, row.roleType)} · ${formatInvitationExpiry(row.expiresAt)}`}
                accessibilityLabel={t('teams.pendingStaffInvitationLabel', {
                  email: row.invitedEmail,
                  role: staffRoleLabel(t, row.roleType),
                })}
                testID={`staff-invitation-row-${row.id}`}
                rightElement={
                  <View style={styles.rowActions}>
                    <TouchableOpacity
                      onPress={() => void sendInvitation(row.invitedEmail, row.roleType, true)}
                      style={styles.rowButton}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('teams.resendStaffInvitation')}: ${row.invitedEmail}`}
                      disabled={inviteStaff.isPending}
                    >
                      <Ionicons name="refresh-outline" size={22} color={colors.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleCancelInvitation(row)}
                      style={styles.rowButton}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('roster.cancelInvitation')}: ${row.invitedEmail}`}
                      disabled={cancelInvitation.isPending}
                    >
                      <Ionicons name="close-circle-outline" size={22} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                }
              />
            ))}
          </>
        )}

        {canManage && headCoachCount === 1 && (
          <ThemedText variant="footnote" color="textTertiary" style={styles.hint}>
            {t('teams.lastHeadCoach')}
          </ThemedText>
        )}
      </ScrollView>

      <ActionMenu
        visible={roleMenuRow !== null}
        title={roleMenuRow ? t('teams.changeRoleTitle', { name: displayName(roleMenuRow.user) }) : ''}
        items={roleMenuRow ? roleMenuItemsFor(roleMenuRow) : []}
        onClose={() => setRoleMenuRow(null)}
      />
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
  roleLabel: { marginTop: spacing.sm, marginBottom: spacing.xs },
  roleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  roleChip: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  roleChipTextSelected: { color: '#FFFFFF' },
  actionButtons: { flexDirection: 'row', gap: spacing.sm },
  actionButton: { flex: 1 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  rowActions: { flexDirection: 'row', gap: spacing.xs },
  // Change-role and remove sit 4pt apart, so they grow to 44pt rather than
  // take hitSlop (overlapping slop would hand one the other's taps).
  rowButton: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { marginTop: spacing.md },
  inviteHint: { marginBottom: spacing.md },
  invitationsHeader: { marginTop: spacing.lg },
  invitationsError: { marginTop: spacing.lg, gap: spacing.sm },
});
