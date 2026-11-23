/**
 * Team join link screen (#210): the link a coach drops in the team's group
 * chat, or shows as a QR code at practice, so families add themselves.
 *
 * Opening the link only lets a signed-in adult ASK to join; every request
 * waits here until someone who may manage the roster approves or declines
 * it. The screen is for those callers only (`canManageRoster`); the API is
 * the authority (403).
 */

import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert, Share, RefreshControl } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Button,
  LoadingSpinner,
  ErrorState,
  Card,
} from '../../../components';
import { QrCode } from '../../../components/QrCode';
import { ActionMenu, type ActionMenuItem } from '../../../components/ActionMenu';
import { BackButton } from '../../../components/BackButton';
import { useToast } from '../../../components/Toast';
import { useTeam, hasTeamPermission, type TeamMember } from '../../../hooks/useTeams';
import { attachablePlayers } from '../../../utils/join-request-targets';
import {
  useJoinLink,
  useCreateJoinLink,
  useRevokeJoinLink,
  useJoinRequests,
  useApproveJoinRequest,
  useDeclineJoinRequest,
  type JoinRequestRow,
} from '../../../hooks/useJoinLink';
import { useTheme } from '../../../hooks/useTheme';
import { useGoBack } from '../../../hooks/useGoBack';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { useAuthUser } from '../../../store/auth-store';
import { getApiErrorMessage } from '../../../services/api-client';
import { displayName } from '../../../utils/display-name';
import { relationshipNoun } from '../../../utils/guardian';
import { formatCalendarDate } from '../../../utils/format-date';
import { MIN_TOUCH_TARGET } from '../../../utils/touch-target';

const QR_SIZE = 220;

export default function TeamJoinLinkScreen() {
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
  const canManageRoster = hasTeamPermission(team, user?.id, 'canManageRoster', user?.role, user?.leagueAdminOf);
  // Both are polled while the screen is open. The server decides whether the
  // link is still live (it answers null once it expired or was replaced), and
  // requests arrive from other phones while the coach shows the code.
  const {
    data: link,
    isLoading: linkLoading,
    error: linkError,
    refetch: refetchLink,
  } = useJoinLink(id, canManageRoster, { poll: true });
  const {
    data: requests,
    error: requestsError,
    refetch: refetchRequests,
  } = useJoinRequests(id, canManageRoster, { poll: true });
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const results = await Promise.all([refetchLink(), refetchRequests()]);
      // What was loaded stays on screen; the coach is only told it may be old.
      if (results.some((result) => result.isError)) {
        toast.showToast(t('joinLink.refreshFailed'), 'error');
      }
    } finally {
      setRefreshing(false);
    }
  };
  const createLink = useCreateJoinLink();
  const revokeLink = useRevokeJoinLink();
  const approve = useApproveJoinRequest();
  const decline = useDeclineJoinRequest();

  const handleCreate = async () => {
    const replacing = link != null;
    try {
      await createLink.mutateAsync({ teamId: id });
      toast.showToast(replacing ? t('joinLink.replaced') : t('joinLink.created'), 'success');
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('joinLink.createFailed')), 'error');
    }
  };

  const confirmNewLink = () => {
    Alert.alert(t('joinLink.newLinkTitle'), t('joinLink.newLinkBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      // Not the screen button's own label: Maestro and VoiceOver must be
      // able to tell the dialog's button from the one behind it.
      { text: t('joinLink.newLinkConfirm'), onPress: () => void handleCreate() },
    ]);
  };

  const confirmTurnOff = () => {
    Alert.alert(t('joinLink.turnOffTitle'), t('joinLink.turnOffBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('joinLink.turnOffConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await revokeLink.mutateAsync({ teamId: id });
            toast.showToast(t('joinLink.turnedOff'), 'success');
          } catch (err) {
            toast.showToast(getApiErrorMessage(err, t('joinLink.turnOffFailed')), 'error');
          }
        },
      },
    ]);
  };

  const handleShare = async (url: string, teamName: string) => {
    try {
      await Share.share({ message: t('joinLink.shareMessage', { team: teamName, url }) });
    } catch {
      toast.showToast(t('joinLink.shareFailed'), 'error');
    }
  };

  /** Who the request would add to the roster. */
  const requestSubject = (row: JoinRequestRow): string =>
    row.kind === 'CHILD' ? row.childName ?? '' : displayName(row.requester);

  const requestDetail = (row: JoinRequestRow): string =>
    row.kind === 'CHILD'
      ? t('joinLink.requestChildDetail', {
          parent: displayName(row.requester),
          relationship: relationshipNoun(row.relationship ?? 'GUARDIAN'),
        })
      : t('joinLink.requestSelfDetail');

  const handleApprove = async (row: JoinRequestRow, target?: TeamMember) => {
    try {
      await approve.mutateAsync({ teamId: id, request: row, playerId: target?.playerId });
      toast.showToast(
        target
          ? t('joinLink.linkedToPlayer', { parent: displayName(row.requester), player: displayName(target.player) })
          : t('joinLink.approved', { name: requestSubject(row) }),
        'success'
      );
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('joinLink.approveFailed')), 'error');
      void refetchRequests();
    }
  };

  // A CHILD request may be the child the coach already typed in (#1072):
  // when the roster has records that could be theirs, Approve asks which.
  const [choosingFor, setChoosingFor] = useState<JoinRequestRow | null>(null);
  const targetsFor = (row: JoinRequestRow): TeamMember[] =>
    row.kind === 'CHILD' && team ? attachablePlayers(team, row.childName) : [];

  const onApprovePress = (row: JoinRequestRow) => {
    if (targetsFor(row).length > 0) {
      setChoosingFor(row);
    } else {
      void handleApprove(row);
    }
  };

  const approveChoices = (row: JoinRequestRow): ActionMenuItem[] => [
    { label: t('joinLink.approveAsNewPlayer'), onPress: () => void handleApprove(row) },
    ...targetsFor(row).map((member) => ({
      label: t('joinLink.approveOntoPlayer', { player: displayName(member.player) }),
      onPress: () => void handleApprove(row, member),
    })),
  ];

  const confirmDecline = (row: JoinRequestRow) => {
    Alert.alert(t('joinLink.declineTitle'), t('joinLink.declineBody', { name: requestSubject(row) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('joinLink.decline'),
        style: 'destructive',
        onPress: async () => {
          try {
            await decline.mutateAsync({ teamId: id, requestId: row.id });
            toast.showToast(t('joinLink.declined'), 'success');
          } catch (err) {
            toast.showToast(getApiErrorMessage(err, t('joinLink.declineFailed')), 'error');
            void refetchRequests();
          }
        },
      },
    ]);
  };

  if (teamLoading || (canManageRoster && linkLoading)) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (teamError || !team) {
    return (
      <ErrorState
        message={teamError instanceof Error ? teamError.message : t('teams.notFound')}
        onRetry={() => void refetchTeam()}
        onBack={goBack}
      />
    );
  }

  if (!canManageRoster) {
    return <ErrorState message={t('joinLink.notAllowed')} onBack={goBack} />;
  }

  // A full-screen error only when there is nothing to show. A re-read that
  // fails (the poll, a pull to refresh, poor signal in a gym) keeps the link
  // and its QR code on screen.
  if (linkError && link === undefined) {
    return (
      <ErrorState
        message={getApiErrorMessage(linkError, t('joinLink.loadFailed'))}
        onRetry={() => void refetchLink()}
        onBack={goBack}
      />
    );
  }

  const deciding = approve.isPending || decline.isPending;
  const full = link != null && link.maxUses != null && link.useCount >= link.maxUses;

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.topHeader,
          { paddingTop: insets.top + spacing.md, paddingHorizontal: padding, borderBottomColor: colors.border },
        ]}
      >
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading>{t('joinLink.title')}</ThemedText>
          <ThemedText variant="caption" color="textSecondary">
            {team.name}
          </ThemedText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} tintColor={colors.primary} />
        }
      >
        <Card variant="elevated" style={styles.linkCard}>
          <ThemedText variant="body" color="textSecondary" style={styles.explain}>
            {t('joinLink.explain')}
          </ThemedText>

          {link ? (
            <>
              <View style={styles.qrWrap}>
                <QrCode
                  value={link.url}
                  size={QR_SIZE}
                  accessibilityLabel={t('joinLink.qrLabel', { team: team.name })}
                  testID="join-link-qr"
                />
              </View>
              <ThemedText variant="caption" color="textSecondary" style={styles.centered}>
                {t('joinLink.qrHint')}
              </ThemedText>
              <ThemedText variant="caption" color={full ? 'error' : 'textSecondary'} style={styles.centered}>
                {full
                  ? t('joinLink.full', { count: link.useCount })
                  : t('joinLink.expires', { date: formatCalendarDate(link.expiresAt) })}
              </ThemedText>
              <Button
                title={t('joinLink.share')}
                onPress={() => void handleShare(link.url, team.name)}
                style={styles.primaryAction}
                testID="join-link-share"
                fullWidth
              />
              <View style={styles.actionButtons}>
                <Button
                  title={t('joinLink.newLink')}
                  onPress={confirmNewLink}
                  variant="outline"
                  loading={createLink.isPending}
                  disabled={createLink.isPending || revokeLink.isPending}
                  style={styles.actionButton}
                  testID="join-link-rotate"
                />
                <Button
                  title={t('joinLink.turnOff')}
                  onPress={confirmTurnOff}
                  variant="outline"
                  loading={revokeLink.isPending}
                  disabled={createLink.isPending || revokeLink.isPending}
                  style={styles.actionButton}
                  testID="join-link-revoke"
                />
              </View>
            </>
          ) : (
            <Button
              title={t('joinLink.create')}
              onPress={() => void handleCreate()}
              loading={createLink.isPending}
              disabled={createLink.isPending}
              testID="join-link-create"
              fullWidth
            />
          )}
        </Card>

        <View style={styles.sectionHeader}>
          <ThemedText variant="h3" heading>{t('joinLink.requestsTitle')}</ThemedText>
          {requests != null && (
            <ThemedText variant="caption" color="textSecondary">
              {t('joinLink.requestCount', { count: requests.length })}
            </ThemedText>
          )}
        </View>

        {/* The error block only when no list was ever loaded: a failed poll keeps the rows. */}
        {requestsError != null && requests == null ? (
          <View style={styles.requestsError}>
            <ThemedText variant="caption" color="error">
              {t('joinLink.requestsLoadFailed')}
            </ThemedText>
            <Button title={t('common.tryAgain')} variant="outline" size="small" onPress={() => void refetchRequests()} />
          </View>
        ) : requests == null || requests.length === 0 ? (
          <ThemedText variant="body" color="textSecondary">
            {t('joinLink.noRequests')}
          </ThemedText>
        ) : (
          requests.map((row) => {
            const subject = requestSubject(row);
            // Not a ListItem: its subtitle is one line, and the email (how a
            // coach recognises who is asking) must never be cut off.
            return (
              <View
                key={row.id}
                style={[styles.requestRow, { borderBottomColor: colors.border }]}
                testID={`join-request-row-${row.id}`}
              >
                <View style={styles.requestText}>
                  <ThemedText variant="body">{subject}</ThemedText>
                  <ThemedText variant="caption" color="textSecondary">
                    {requestDetail(row)}
                  </ThemedText>
                  {row.requester.email != null && (
                    <ThemedText variant="caption" color="textSecondary">
                      {row.requester.email}
                    </ThemedText>
                  )}
                </View>
                <View style={styles.rowActions}>
                  <TouchableOpacity
                    onPress={() => onApprovePress(row)}
                    style={styles.rowButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('joinLink.approveLabel', { name: subject })}
                    disabled={deciding}
                  >
                    <Ionicons name="checkmark-circle-outline" size={26} color={colors.success} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => confirmDecline(row)}
                    style={styles.rowButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('joinLink.declineLabel', { name: subject })}
                    disabled={deciding}
                  >
                    <Ionicons name="close-circle-outline" size={26} color={colors.error} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
      <ActionMenu
        visible={choosingFor !== null}
        title={choosingFor ? t('joinLink.approveChoiceTitle', { name: requestSubject(choosingFor) }) : ''}
        items={choosingFor ? approveChoices(choosingFor) : []}
        onClose={() => setChoosingFor(null)}
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
  linkCard: { marginBottom: spacing.lg },
  explain: { marginBottom: spacing.md },
  qrWrap: { alignItems: 'center', marginBottom: spacing.sm },
  centered: { textAlign: 'center', marginBottom: spacing.xs },
  primaryAction: { marginTop: spacing.md },
  actionButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  actionButton: { flex: 1 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  requestsError: { gap: spacing.sm },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  requestText: { flex: 1, gap: spacing.xxs },
  rowActions: { flexDirection: 'row', gap: spacing.xs },
  // Approve and decline sit 4pt apart, so they grow to 44pt rather than take
  // hitSlop (overlapping slop would hand one the other's taps).
  rowButton: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
