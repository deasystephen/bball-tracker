/**
 * Practice detail (#33): when and where, the recurrence, availability
 * (one tap: Going / Maybe / Not going, plus an optional note), the headcount,
 * and for the coach the roster breakdown and the ⋯ menu.
 *
 * Times show in the session's own zone (`formatPracticeTimeRange`), with the
 * zone named when it is not the device's.
 *
 * Availability: only a rostered player answers for themself, and a guardian
 * answers for a rostered child (`playerId`); the "Responding for" chips
 * appear when there is more than one choice. Anyone else (a coach who is not
 * on the roster) sees the counts only. A cancelled practice takes no answers.
 *
 * The ⋯ menu (`ActionMenu`, never an `Alert`) needs `canManageTeam` and makes
 * the series choice explicit: "Edit this practice" / "Edit all future
 * practices", "Cancel this practice" / "Cancel all future practices", and
 * "Delete this practice". Cancelling one asks for an optional reason inline;
 * cancelling the series (the server deletes every session that has not
 * started, with its answers) and deleting confirm in a second menu.
 */

import React, { useMemo, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  Button,
  Input,
  LoadingSpinner,
  ErrorState,
  ActionMenu,
  type ActionMenuItem,
} from '../../../components';
import { BackButton } from '../../../components/BackButton';
import { useToast } from '../../../components/Toast';
import {
  usePractice,
  usePracticeAvailability,
  useSubmitPracticeAvailability,
  useCancelPractice,
  useCancelPracticeSeries,
  useDeletePractice,
} from '../../../hooks/usePractices';
import { useTeam, hasTeamPermission } from '../../../hooks/useTeams';
import { useGoBack } from '../../../hooks/useGoBack';
import { useTheme } from '../../../hooks/useTheme';
import { useAuthUser } from '../../../store/auth-store';
import { getApiErrorMessage } from '../../../services/api-client';
import { useTranslation } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { HEADER_ICON_HIT_SLOP, MIN_TOUCH_TARGET } from '../../../utils/touch-target';
import { formatLongDate } from '../../../utils/format-date';
import { displayName } from '../../../utils/display-name';
import { sortRosterMembers } from '../../../utils/roster-sort';
import {
  AVAILABILITY_COMMENT_MAX,
  PRACTICE_CANCEL_REASON_MAX,
  formatPracticeTimeRange,
  formatRecurrence,
  practiceRespondents,
  practiceTitle,
} from '../../../utils/practice-schedule';
import type { RsvpStatus } from '../../../types/game';

const ANSWERS: { status: RsvpStatus; key: string }[] = [
  { status: 'YES', key: 'games.rsvp.going' },
  { status: 'MAYBE', key: 'games.rsvp.maybe' },
  { status: 'NO', key: 'games.rsvp.notGoing' },
];

type Confirm = 'series' | 'delete' | null;

export default function PracticeDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: practice, isLoading, error, refetch } = usePractice(id);
  const teamId = practice?.teamId ?? '';
  const goBack = useGoBack(teamId ? `/teams/${teamId}/schedule` : '/(tabs)/teams');
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const user = useAuthUser();

  const { data: team } = useTeam(teamId);
  const { data: availabilityData } = usePracticeAvailability(id);
  const submit = useSubmitPracticeAvailability();
  const cancelOne = useCancelPractice();
  const cancelSeries = useCancelPracticeSeries();
  const deleteOne = useDeletePractice();

  const canManageTeam = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);
  const canManageRoster = hasTeamPermission(team, user?.id, 'canManageRoster', user?.role, user?.leagueAdminOf);
  const showBreakdown = canManageTeam || canManageRoster;

  const respondents = useMemo(() => practiceRespondents(user, team), [user, team]);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const respondingFor: string | null =
    picked !== undefined && respondents.some((r) => r.id === picked) ? picked : (respondents[0]?.id ?? null);
  const subjectId = respondingFor ?? user?.id;
  const myRow = availabilityData?.availability.find((row) => row.userId === subjectId);

  // The note field shows the selected person's stored note until it is edited;
  // a draft belongs to the person it was typed for.
  const storedComment = myRow?.comment ?? '';
  const [draft, setDraft] = useState<{ subjectId: string | undefined; text: string } | null>(null);
  const comment = draft && draft.subjectId === subjectId ? draft.text : storedComment;
  const setComment = (text: string) => setDraft({ subjectId, text });

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  if (isLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }
  if (error || !practice) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('practices.notFound')}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }

  const cancelled = practice.status === 'CANCELLED';
  const series = practice.series;
  const seriesActive = !!series && !series.cancelledAt;
  const summary = availabilityData?.summary ?? practice.availabilitySummary;
  const playerId = respondingFor ?? undefined;

  const answer = (status: RsvpStatus) => {
    submit.mutate(
      { practiceId: practice.id, status, playerId },
      { onError: (err) => toast.showToast(getApiErrorMessage(err, t('practices.errors.answerFailed')), 'error') }
    );
  };

  const saveComment = () => {
    if (!myRow) return;
    submit.mutate(
      { practiceId: practice.id, status: myRow.status, playerId, comment: comment.trim() },
      {
        onSuccess: () => {
          setDraft(null);
          toast.showToast(t('practices.noteSaved'), 'success');
        },
        onError: (err) => toast.showToast(getApiErrorMessage(err, t('practices.errors.answerFailed')), 'error'),
      }
    );
  };

  const confirmCancelOne = async () => {
    try {
      await cancelOne.mutateAsync({ practiceId: practice.id, reason: reason.trim() || undefined });
      setCancelling(false);
      setReason('');
      toast.showToast(t('practices.cancelledToast'), 'success');
    } catch (err) {
      Alert.alert(t('common.error'), getApiErrorMessage(err, t('practices.errors.cancelFailed')));
    }
  };

  const confirmCancelSeries = async () => {
    if (!series) return;
    try {
      const result = await cancelSeries.mutateAsync(series.id);
      toast.showToast(t('practices.seriesCancelledToast', { count: result.deletedSessions ?? 0 }), 'success');
      goBack();
    } catch (err) {
      Alert.alert(t('common.error'), getApiErrorMessage(err, t('practices.errors.cancelFailed')));
    }
  };

  const confirmDelete = async () => {
    try {
      await deleteOne.mutateAsync({ practiceId: practice.id, inSeries: practice.seriesId !== null });
      toast.showToast(t('practices.deletedToast'), 'success');
      goBack();
    } catch (err) {
      Alert.alert(t('common.error'), getApiErrorMessage(err, t('practices.errors.deleteFailed')));
    }
  };

  const menuItems: ActionMenuItem[] = [];
  // A session of a cancelled series is history: the API refuses to edit it.
  const editable = !cancelled && (!series || seriesActive);
  if (editable) {
    menuItems.push({
      label: series ? t('practices.menu.editOne') : t('practices.menu.edit'),
      onPress: () => router.push(`/practices/${practice.id}/edit?scope=one`),
    });
    if (seriesActive) {
      menuItems.push({
        label: t('practices.menu.editSeries'),
        onPress: () => router.push(`/practices/${practice.id}/edit?scope=series`),
      });
    }
  }
  if (!cancelled) {
    menuItems.push({
      label: series ? t('practices.menu.cancelOne') : t('practices.menu.cancel'),
      destructive: true,
      onPress: () => setCancelling(true),
    });
  }
  if (seriesActive) {
    // `waitForClose`: the confirmation is a second sheet, which iOS will not
    // present while this one is still closing (ActionMenu's file comment).
    menuItems.push({
      label: t('practices.menu.cancelSeries'),
      destructive: true,
      waitForClose: true,
      onPress: () => setConfirm('series'),
    });
  }
  menuItems.push({
    label: series ? t('practices.menu.deleteOne') : t('practices.menu.delete'),
    destructive: true,
    waitForClose: true,
    onPress: () => setConfirm('delete'),
  });

  const runMenuItem = (item: ActionMenuItem): ActionMenuItem => ({
    ...item,
    onPress: () => {
      setMenuOpen(false);
      item.onPress();
    },
  });

  const confirmItems: ActionMenuItem[] =
    confirm === 'series'
      ? [{ label: t('practices.menu.cancelSeries'), destructive: true, onPress: () => { setConfirm(null); confirmCancelSeries(); } }]
      : [{ label: t('practices.menu.deleteConfirm'), destructive: true, onPress: () => { setConfirm(null); confirmDelete(); } }];

  const members = sortRosterMembers(team?.members ?? [], 'name');
  const rowsByPlayer = new Map((availabilityData?.availability ?? []).map((row) => [row.userId, row]));
  const groups: { key: string; label: string; status: RsvpStatus | null }[] = [
    { key: 'yes', label: t('games.rsvp.going'), status: 'YES' },
    { key: 'maybe', label: t('games.rsvp.maybe'), status: 'MAYBE' },
    { key: 'no', label: t('games.rsvp.notGoing'), status: 'NO' },
    { key: 'none', label: t('practices.noAnswer'), status: null },
  ];

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + spacing.sm, paddingHorizontal: padding, borderBottomColor: colors.border },
        ]}
      >
        <BackButton onPress={goBack} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h3" heading numberOfLines={2}>
            {practiceTitle(practice)}
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary" numberOfLines={1}>
            {practice.team.name}
          </ThemedText>
        </View>
        {canManageTeam && menuItems.length > 0 ? (
          <TouchableOpacity
            onPress={() => setMenuOpen(true)}
            style={styles.iconButton}
            hitSlop={HEADER_ICON_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t('practices.menu.a11y')}
            testID="practice-menu-button"
          >
            <Ionicons name="ellipsis-horizontal" size={24} color={colors.text} />
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { padding, paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {cancelled ? (
          <Card variant="default" style={[styles.card, { backgroundColor: colors.error + '15' }]}>
            <ThemedText variant="bodyBold" color="error" testID="practice-cancelled-banner">
              {t('practices.cancelledBanner')}
            </ThemedText>
            {practice.cancelReason ? (
              <ThemedText variant="body" style={styles.spacedSmall}>
                {practice.cancelReason}
              </ThemedText>
            ) : null}
          </Card>
        ) : null}

        <Card variant="default" style={styles.card}>
          <InfoRow icon="calendar-outline" label={t('practices.date')}>
            {formatLongDate(practice.startsAt, { timeZone: practice.timezone })}
          </InfoRow>
          <InfoRow icon="time-outline" label={t('practices.time')}>
            {formatPracticeTimeRange(practice)}
          </InfoRow>
          {series ? (
            <InfoRow icon="repeat" label={t('practices.repeats')}>
              {series.cancelledAt ? t('practices.seriesEnded') : formatRecurrence(series)}
            </InfoRow>
          ) : null}
          {practice.location ? (
            <InfoRow icon="location-outline" label={t('practices.form.location')}>
              {practice.location}
            </InfoRow>
          ) : null}
          {practice.notes ? (
            <InfoRow icon="document-text-outline" label={t('practices.form.notes')}>
              {practice.notes}
            </InfoRow>
          ) : null}
        </Card>

        {cancelling ? (
          <Card variant="default" style={styles.card} testID="practice-cancel-panel">
            <ThemedText variant="h3" heading>
              {series ? t('practices.menu.cancelOne') : t('practices.menu.cancel')}
            </ThemedText>
            <ThemedText variant="caption" color="textSecondary" style={styles.spacedSmall}>
              {t('practices.cancelExplain')}
            </ThemedText>
            <Input
              label={t('practices.cancelReason')}
              placeholder={t('practices.cancelReasonPlaceholder')}
              value={reason}
              onChangeText={setReason}
              maxLength={PRACTICE_CANCEL_REASON_MAX}
              testID="practice-cancel-reason"
            />
            <Button
              title={t('practices.confirmCancel')}
              variant="danger"
              onPress={confirmCancelOne}
              loading={cancelOne.isPending}
              fullWidth
              testID="practice-cancel-confirm"
            />
            <Button
              title={t('practices.keepPractice')}
              variant="outline"
              onPress={() => setCancelling(false)}
              fullWidth
              style={styles.spacedSmall}
            />
          </Card>
        ) : null}

        <Card variant="default" style={styles.card}>
          <ThemedText variant="h3" heading>
            {t('practices.availability')}
          </ThemedText>

          {!cancelled && respondents.length > 0 ? (
            <>
              {respondents.length > 1 ? (
                <View style={styles.respondingFor} testID="practice-responding-for">
                  <ThemedText variant="caption" color="textSecondary" style={styles.label}>
                    {t('games.rsvp.respondingFor')}
                  </ThemedText>
                  <View style={styles.chips}>
                    {respondents.map((respondent) => {
                      const selected = respondent.id === respondingFor;
                      return (
                        <TouchableOpacity
                          key={respondent.id ?? 'self'}
                          onPress={() => setPicked(respondent.id)}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          accessibilityLabel={t('games.rsvp.respondForA11y', { name: respondent.name })}
                          style={[
                            styles.chip,
                            { borderColor: colors.border },
                            selected && { backgroundColor: colors.primary, borderColor: colors.primary },
                          ]}
                        >
                          <ThemedText variant="captionBold" style={selected ? styles.onPrimary : undefined}>
                            {respondent.name}
                          </ThemedText>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ) : respondingFor ? (
                <ThemedText variant="caption" color="textSecondary" style={styles.label}>
                  {t('practices.answeringFor', { name: respondents[0].name })}
                </ThemedText>
              ) : null}

              <View style={styles.answers}>
                {ANSWERS.map(({ status, key }) => {
                  const selected = myRow?.status === status;
                  return (
                    <TouchableOpacity
                      key={status}
                      onPress={() => answer(status)}
                      disabled={submit.isPending}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      testID={`practice-answer-${status}`}
                      style={[
                        styles.answer,
                        { borderColor: colors.border },
                        selected && { backgroundColor: colors.primary, borderColor: colors.primary },
                      ]}
                    >
                      <ThemedText variant="captionBold" style={selected ? styles.onPrimary : undefined}>
                        {t(key)}
                      </ThemedText>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Input
                label={t('practices.note')}
                placeholder={myRow ? t('practices.notePlaceholder') : t('practices.noteNeedsAnswer')}
                value={comment}
                onChangeText={setComment}
                editable={!!myRow}
                maxLength={AVAILABILITY_COMMENT_MAX}
                testID="practice-note-input"
              />
              {myRow && comment.trim() !== storedComment ? (
                <Button
                  title={t('practices.saveNote')}
                  variant="outline"
                  size="small"
                  onPress={saveComment}
                  loading={submit.isPending}
                  testID="practice-note-save"
                />
              ) : null}
            </>
          ) : null}

          {summary ? (
            <ThemedText variant="caption" color="textSecondary" style={styles.spaced} testID="practice-summary">
              {[
                t('games.rsvp.goingCount', { count: summary.yes }),
                t('games.rsvp.maybeCount', { count: summary.maybe }),
                t('games.rsvp.notGoingCount', { count: summary.no }),
              ].join(' · ')}
            </ThemedText>
          ) : null}
        </Card>

        {showBreakdown && members.length > 0 ? (
          <Card variant="default" style={styles.card}>
            <ThemedText variant="h3" heading>
              {t('practices.roster')}
            </ThemedText>
            {groups.map((group) => {
              const inGroup = members.filter((member) => {
                const row = rowsByPlayer.get(member.playerId);
                return group.status === null ? !row : row?.status === group.status;
              });
              if (inGroup.length === 0) return null;
              return (
                <View key={group.key} style={styles.spaced}>
                  <ThemedText variant="captionBold" color="textSecondary">
                    {t('practices.groupCount', { label: group.label, n: inGroup.length })}
                  </ThemedText>
                  {inGroup.map((member) => {
                    const note = rowsByPlayer.get(member.playerId)?.comment;
                    return (
                      <View key={member.id} style={styles.memberRow}>
                        <ThemedText variant="body">{displayName(member.player)}</ThemedText>
                        {note ? (
                          <ThemedText variant="caption" color="textSecondary">
                            {note}
                          </ThemedText>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </Card>
        ) : null}
      </ScrollView>

      <ActionMenu
        visible={menuOpen}
        title={practiceTitle(practice)}
        items={menuItems.map(runMenuItem)}
        onClose={() => setMenuOpen(false)}
      />
      <ActionMenu
        visible={confirm !== null}
        title={confirm === 'series' ? t('practices.confirmSeriesTitle') : t('practices.confirmDeleteTitle')}
        items={confirmItems}
        onClose={() => setConfirm(null)}
      />
    </ThemedView>
  );
}

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={20} color={colors.primary} />
      <View style={styles.infoText}>
        <ThemedText variant="caption" color="textSecondary">
          {label}
        </ThemedText>
        <ThemedText variant="body">{children}</ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { marginLeft: -spacing.xs },
  headerContent: { flex: 1, marginLeft: spacing.sm },
  // Drawn like BackButton (24pt icon + spacing.sm padding); HEADER_ICON_HIT_SLOP makes it 44pt.
  iconButton: { padding: spacing.sm },
  scroll: { paddingTop: spacing.lg },
  card: { marginBottom: spacing.md },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  infoText: { flex: 1 },
  label: { marginBottom: spacing.xs },
  spaced: { marginTop: spacing.md },
  spacedSmall: { marginTop: spacing.sm },
  respondingFor: { marginTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  answers: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.md },
  answer: {
    flex: 1,
    alignItems: 'center',
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  onPrimary: { color: '#FFFFFF' },
  memberRow: { paddingVertical: spacing.xs },
});
