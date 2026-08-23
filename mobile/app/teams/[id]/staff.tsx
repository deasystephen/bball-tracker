/**
 * Team staff screen — list coaches / managers, add by email, change role,
 * remove (role matrix decision 2, B2.3).
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
import { useTeam, canManageStaff } from '../../../hooks/useTeams';
import {
  useTeamStaff,
  useAddStaff,
  useUpdateStaffRole,
  useRemoveStaff,
  STAFF_ROLE_TYPES,
  type StaffRoleType,
  type TeamStaffRow,
} from '../../../hooks/useTeamStaff';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { useAuthUser } from '../../../store/auth-store';
import { getApiErrorMessage } from '../../../services/api-client';

const ROLE_LABEL_KEY: Record<StaffRoleType, string> = {
  HEAD_COACH: 'teams.roleHeadCoach',
  ASSISTANT_COACH: 'teams.roleAssistantCoach',
  TEAM_MANAGER: 'teams.roleTeamManager',
};

const isStaffRoleType = (type: string): type is StaffRoleType =>
  (STAFF_ROLE_TYPES as readonly string[]).includes(type);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function TeamStaffScreen() {
  const router = useRouter();
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

  const [showAddForm, setShowAddForm] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [roleType, setRoleType] = useState<StaffRoleType>('ASSISTANT_COACH');

  const canManage = canManageStaff(team, user?.id, user?.role, user?.leagueAdminOf);

  const headCoachCount = useMemo(
    () => (staff ?? []).filter((s) => s.role.type === 'HEAD_COACH').length,
    [staff]
  );

  const roleLabel = (row: TeamStaffRow) =>
    isStaffRoleType(row.role.type) ? t(ROLE_LABEL_KEY[row.role.type]) : row.role.name;

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
      const status = (err as { apiError?: { status?: number } }).apiError?.status;
      if (status === 404) {
        setEmailError(t('teams.staffNoAccount'));
        return;
      }
      toast.showToast(getApiErrorMessage(err, t('teams.staffAddFailed')), 'error');
    }
  };

  const handleChangeRole = (row: TeamStaffRow) => {
    const options = STAFF_ROLE_TYPES.filter((type) => type !== row.role.type).map((type) => ({
      text: t(ROLE_LABEL_KEY[type]),
      onPress: async () => {
        try {
          await updateRole.mutateAsync({ teamId: id, userId: row.userId, roleType: type });
          toast.showToast(t('teams.roleUpdated'), 'success');
        } catch (err) {
          toast.showToast(getApiErrorMessage(err, t('teams.roleUpdateFailed')), 'error');
        }
      },
    }));
    Alert.alert(t('teams.changeRoleTitle', { name: row.user.name }), undefined, [
      ...options,
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  };

  const handleRemove = (row: TeamStaffRow, isSelf: boolean) => {
    Alert.alert(
      isSelf ? t('teams.leaveTeam') : t('teams.removeStaffTitle'),
      isSelf ? t('teams.leaveTeamMessage') : t('teams.removeStaffMessage', { name: row.user.name }),
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
        message={error instanceof Error ? error.message : 'Team not found'}
        onRetry={() => {
          refetchTeam();
          refetchStaff();
        }}
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
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2">{t('teams.staff')}</ThemedText>
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
                <ThemedText variant="h4" style={styles.formTitle}>
                  {t('teams.addStaff')}
                </ThemedText>
                <Input
                  label={t('teams.staffEmail')}
                  placeholder={t('teams.staffEmailPlaceholder')}
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    if (emailError) setEmailError(undefined);
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
                        accessibilityLabel={t(ROLE_LABEL_KEY[type])}
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
                          {t(ROLE_LABEL_KEY[type])}
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={styles.actionButtons}>
                  <Button
                    title={t('common.cancel')}
                    onPress={() => {
                      setShowAddForm(false);
                      setEmail('');
                      setEmailError(undefined);
                    }}
                    variant="outline"
                    style={styles.actionButton}
                  />
                  <Button
                    title={t('teams.addStaff')}
                    onPress={handleAdd}
                    loading={addStaff.isPending}
                    disabled={addStaff.isPending}
                    style={styles.actionButton}
                    testID="staff-add-submit"
                  />
                </View>
              </>
            ) : (
              <Button title={t('teams.addStaff')} onPress={() => setShowAddForm(true)} />
            )}
          </Card>
        )}

        <View style={styles.sectionHeader}>
          <ThemedText variant="h3">{t('teams.staff')}</ThemedText>
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
                title={isSelf ? `${row.user.name} (${t('teams.you')})` : row.user.name}
                subtitle={subtitle}
                accessibilityLabel={`${row.user.name}, ${roleLabel(row)}`}
                rightElement={
                  <View style={styles.rowActions}>
                    {canManage && (
                      <TouchableOpacity
                        onPress={() => handleChangeRole(row)}
                        style={styles.rowButton}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('teams.changeRole')}: ${row.user.name}`}
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
                          isSelf ? t('teams.leaveTeam') : `${t('teams.removeStaff')}: ${row.user.name}`
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

        {canManage && headCoachCount === 1 && (
          <ThemedText variant="footnote" color="textTertiary" style={styles.hint}>
            {t('teams.lastHeadCoach')}
          </ThemedText>
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
  rowButton: { padding: spacing.xs },
  hint: { marginTop: spacing.md },
});
