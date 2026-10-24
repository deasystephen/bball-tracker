/**
 * Manage Players screen — unified Add Player + roster with invite-status chips
 * (roster/invite unification spec, docs/plans/roster-invite-unification-spec.md).
 *
 * One form adds any player: name only → roster-only managed player; with a
 * player email → rostered immediately + invited ("added" email); an email that
 * already has an account → invitation only (appears in the "Invited" section
 * until they accept). An optional parent email invites a guardian in the same
 * step (rostered cases only — the server refuses it for existing accounts).
 *
 * Chips derive via utils/roster-status.ts (never inline). Resend targets only
 * PENDING rows; "Invite"/"Resend" are the same supersede create call.
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ThemedView,
  ThemedText,
  Input,
  Button,
  ListItem,
  LoadingSpinner,
  ErrorState,
  Card,
  AvatarPicker,
} from '../../../components';
import {
  useTeam,
  useRemovePlayerFromTeam,
  useAddRosterPlayer,
  useUpdateTeamMember,
  hasTeamPermission,
  type AddRosterPlayerResponse,
  type TeamMember,
} from '../../../hooks/useTeams';
import {
  useCreateInvitation,
  useCancelInvitation,
  useTeamInvitations,
  type TeamInvitation,
} from '../../../hooks/useInvitations';
import { usePlayers, useUpdatePlayer, type Player } from '../../../hooks/usePlayers';
import {
  getRosterStatus,
  rosterStatusLabel,
  rosterStatusColor,
  type RosterStatus,
  type RosterStatusResult,
} from '../../../utils/roster-status';
import {
  getEmailDeliveryIssue,
  emailDeliveryIssueLabel,
  emailDeliveryIssueExplanation,
  type EmailDeliveryIssue,
} from '../../../utils/email-delivery';
import type { NormalizedApiError } from '../../../services/api-client';
import { isInvitationExpired } from '../../../utils/invitation-expiry';
import { RelationshipChips } from '../../../components/RelationshipChips';
import { ActionMenu, type ActionMenuItem } from '../../../components/ActionMenu';
import { displayName } from '../../../utils/display-name';
import type { GuardianRelationship } from '../../../../shared/types';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing, borderRadius } from '../../../theme';
import { getHorizontalPadding, getResponsiveValue } from '../../../utils/responsive';
import { MIN_TOUCH_TARGET, touchTargetHitSlop } from '../../../utils/touch-target';
import { Ionicons } from '@expo/vector-icons';
import { uploadAvatar } from '../../../services/upload-service';
import { uploadAwareErrorMessage } from '../../../utils/upload-error';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';
import { useGoBack } from '../../../hooks/useGoBack';
import { BackButton } from '../../../components/BackButton';

const CLEAR_SELECTION_ICON_SIZE = 24;
/** The clear-selection icon draws at 32pt (24 + 4pt padding); the slop makes it 44pt. */
const CLEAR_SELECTION_HIT_SLOP = touchTargetHitSlop(CLEAR_SELECTION_ICON_SIZE + 2 * spacing.xs);

interface ChipPalette {
  success: string;
  primary: string;
  warning: string;
  textSecondary: string;
}

function StatusChip({
  status,
  playerName,
  colors,
}: {
  status: RosterStatus;
  playerName: string;
  colors: ChipPalette;
}) {
  const { t } = useTranslation();
  const color = rosterStatusColor(status, colors);
  return (
    <View
      style={[styles.chip, { borderColor: color }]}
      // Row-anchored so an E2E assertion can't false-pass off a neighboring
      // row's chip (red-team review) — Maestro asserts this exact string.
      accessibilityLabel={t('roster.statusA11y', { name: playerName, status: rosterStatusLabel(status) })}
    >
      <ThemedText variant="caption" style={{ color }}>
        {rosterStatusLabel(status)}
      </ThemedText>
    </View>
  );
}

/** Second chip on a row whose address SES stopped delivering to (#449). */
function EmailIssueChip({
  issue,
  playerName,
  color,
}: {
  issue: EmailDeliveryIssue;
  playerName: string;
  color: string;
}) {
  const { t } = useTranslation();
  return (
    <View
      style={[styles.chip, { borderColor: color }]}
      // Row-anchored, like StatusChip.
      accessibilityLabel={t('roster.emailIssueA11y', { name: playerName, issue: emailDeliveryIssueLabel(issue) })}
    >
      <ThemedText variant="caption" style={{ color }}>
        {emailDeliveryIssueLabel(issue)}
      </ThemedText>
    </View>
  );
}

/** Same shape the backend's `z.string().email()` accepts for everyday addresses. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Roster statuses where the player is still waiting on an invitation email. */
const AWAITING_INVITE: ReadonlySet<RosterStatus> = new Set(['invited', 'invite_expired', 'not_invited']);

export default function ManagePlayersScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/teams');
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  // Same horizontal padding ListItem gives its own content
  const rowPadding = getResponsiveValue(spacing.md, spacing.lg);
  const insets = useSafeAreaInsets();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [playerEmail, setPlayerEmail] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianRelationship, setGuardianRelationship] =
    useState<GuardianRelationship>('GUARDIAN');
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [position, setPosition] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [menuForPlayerId, setMenuForPlayerId] = useState<string | null>(null);
  // Jersey/position edit sheet (opened from the row's ActionMenu)
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [editJersey, setEditJersey] = useState('');
  const [editPosition, setEditPosition] = useState('');
  // Fix-email sheet (opened from the ActionMenu of a row with an email issue)
  const [emailEditMember, setEmailEditMember] = useState<TeamMember | null>(null);
  const [editEmail, setEditEmail] = useState('');

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const removePlayer = useRemovePlayerFromTeam();
  const updateTeamMember = useUpdateTeamMember();
  const updatePlayer = useUpdatePlayer();
  const addRosterPlayer = useAddRosterPlayer();
  const createInvitation = useCreateInvitation();
  const cancelInvitation = useCancelInvitation();
  const toast = useToast();

  // Roster changes need `canManageRoster` (backend team-service); guard the
  // screen itself since it is reachable by deep link.
  const user = useAuthUser();
  const allowed = useAccessGuard(
    !!user && !!team,
    hasTeamPermission(team, user?.id, 'canManageRoster', user?.role, user?.leagueAdminOf),
    t('teams.rosterNotAllowed'),
    { fallback: `/teams/${id}` }
  );

  // Existing-account invitees not yet on the roster (case 3) come from the
  // invitations endpoint — the team payload carries rostered players only.
  const {
    data: teamInvitationsData,
    error: teamInvitationsError,
    refetch: refetchTeamInvitations,
  } = useTeamInvitations(id, 'PENDING');

  // Search for players
  const { data: playersData, isLoading: searchingPlayers } = usePlayers({
    search: searchQuery || undefined,
    role: 'PLAYER',
    limit: 10,
  });

  const players = playersData?.players || [];

  const resetAddForm = () => {
    setName('');
    setPlayerEmail('');
    setGuardianEmail('');
    setGuardianRelationship('GUARDIAN');
    setJerseyNumber('');
    setPosition('');
    setAvatarUri(null);
    setShowAddForm(false);
  };

  const toastAddResult = (result: AddRosterPlayerResponse, hadGuardianEmail: boolean) => {
    if (!result.rostered && result.invited) {
      toast.showToast(t('roster.addedExistingAccount'), 'info');
    } else if (result.invited) {
      toast.showToast(t('roster.addedAndInvited'), 'success');
    } else {
      toast.showToast(t('roster.added'), 'success');
    }

    if (result.emails?.player === false) {
      toast.showToast(t('roster.addEmailFailed'), 'error');
    }
    if (hadGuardianEmail) {
      if (!result.guardianInvited && result.guardianReason) {
        toast.showToast(result.guardianReason, 'info');
      } else if (result.emails?.guardian === false) {
        toast.showToast(t('guardians.addPlayerEmailFailed'), 'error');
      }
    }
  };

  const handleAddPlayer = async () => {
    if (!name.trim()) {
      Alert.alert(t('common.error'), t('roster.nameRequired'));
      return;
    }
    const trimmedGuardianEmail = guardianEmail.trim();

    try {
      let profilePictureUrl: string | undefined;
      if (avatarUri) {
        setUploadingAvatar(true);
        profilePictureUrl = await uploadAvatar(avatarUri);
        setUploadingAvatar(false);
      }

      const result = await addRosterPlayer.mutateAsync({
        teamId: id,
        data: {
          name: name.trim(),
          playerEmail: playerEmail.trim() || undefined,
          guardianEmail: trimmedGuardianEmail || undefined,
          guardianRelationship: trimmedGuardianEmail ? guardianRelationship : undefined,
          jerseyNumber: jerseyNumber ? parseInt(jerseyNumber, 10) : undefined,
          position: position.trim() || undefined,
          profilePictureUrl,
        },
      });

      resetAddForm();
      setSearchQuery('');
      setSelectedPlayer(null);
      toastAddResult(result, !!trimmedGuardianEmail);
    } catch (err) {
      setUploadingAvatar(false);
      toast.showToast(uploadAwareErrorMessage(err, t, 'roster.addFailed'), 'error');
    }
  };

  const handleInviteSelectedPlayer = async () => {
    if (!selectedPlayer) {
      Alert.alert(t('common.error'), t('roster.selectPlayer'));
      return;
    }

    try {
      const response = await createInvitation.mutateAsync({
        teamId: id,
        data: {
          playerId: selectedPlayer.id,
          jerseyNumber: jerseyNumber ? parseInt(jerseyNumber, 10) : undefined,
          position: position.trim() || undefined,
        },
      });

      setJerseyNumber('');
      setPosition('');
      setSelectedPlayer(null);
      setSearchQuery('');
      toast.showToast(t('roster.invitationSent'), 'success');
      if (response.emailSent === false) {
        toast.showToast(t('roster.inviteEmailFailed'), 'error');
      }
    } catch (err) {
      toast.showToast(err instanceof Error ? err.message : t('guardians.inviteFailed'), 'error');
    }
  };

  /** "Resend" and "Invite" are the same supersede create (fresh token). */
  const handleResendInvite = async (playerId: string, playerName: string) => {
    try {
      const response = await createInvitation.mutateAsync({
        teamId: id,
        data: { playerId, supersede: true },
      });
      if (response.emailSent === false) {
        toast.showToast(t('roster.resendEmailFailed', { name: playerName }), 'error');
      } else if (response.emailSent === null) {
        toast.showToast(t('roster.noEmailOnFile', { name: playerName }), 'info');
      } else {
        toast.showToast(t('roster.resent', { name: playerName }), 'success');
      }
    } catch (err) {
      toast.showToast(err instanceof Error ? err.message : t('guardians.resendFailed'), 'error');
    }
  };

  const handleCancelInvite = (invitationId: string, playerName: string) => {
    Alert.alert(
      t('roster.cancelInvitationTitle'),
      t('roster.cancelInvitationBody', { name: playerName }),
      [
        { text: t('roster.keepInvitation'), style: 'cancel' },
        {
          text: t('roster.cancelInvitation'),
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelInvitation.mutateAsync({ invitationId, teamId: id });
              toast.showToast(t('roster.invitationCancelled'), 'success');
            } catch (err) {
              toast.showToast(err instanceof Error ? err.message : t('roster.cancelInvitationFailed'), 'error');
            }
          },
        },
      ]
    );
  };

  const openMemberEdit = (member: TeamMember) => {
    // `!= null` — 0 is a valid jersey number
    setEditJersey(member.jerseyNumber != null ? String(member.jerseyNumber) : '');
    setEditPosition(member.position ?? '');
    setEditingMember(member);
  };

  const handleSaveMemberEdit = async () => {
    if (!editingMember) return;
    const trimmedJersey = editJersey.trim();
    // Empty input clears the number (the API takes null); the input is
    // digit-only with maxLength 2, so parsed is always 0-99 when present.
    const parsedJersey = trimmedJersey === '' ? null : parseInt(trimmedJersey, 10);

    try {
      await updateTeamMember.mutateAsync({
        teamId: id,
        playerId: editingMember.playerId,
        data: {
          jerseyNumber: parsedJersey,
          position: editPosition.trim() || null,
        },
      });
      setEditingMember(null);
      toast.showToast(t('roster.detailsUpdated'), 'success');
    } catch (err) {
      toast.showToast(err instanceof Error ? err.message : t('roster.updateFailed'), 'error');
    }
  };

  const openEmailEdit = (member: TeamMember) => {
    setEditEmail(member.player.email ?? '');
    setEmailEditMember(member);
  };

  const trimmedEditEmail = editEmail.trim().toLowerCase();
  // The flag follows the address: saving the same one would change nothing
  // server-side, so the sheet only accepts a different, well-formed address.
  const canSaveEmail =
    EMAIL_PATTERN.test(trimmedEditEmail) &&
    trimmedEditEmail !== (emailEditMember?.player.email ?? '').trim().toLowerCase();

  /**
   * Correct the address, then send the invitation to it in the same step when
   * the player is still waiting on one — that is why the coach is here.
   */
  const handleSaveEmail = async (resend: boolean) => {
    if (!emailEditMember || !canSaveEmail) return;
    const { playerId } = emailEditMember;
    const playerName = displayName(emailEditMember.player);

    try {
      await updatePlayer.mutateAsync({ playerId, data: { email: trimmedEditEmail } });
    } catch (err) {
      // Only the coach who added an unclaimed player may change its address
      // (backend rule B2.10); the server's own text is about "your profile".
      const forbidden = (err as NormalizedApiError).apiError?.status === 403;
      toast.showToast(
        forbidden
          ? t('roster.emailEditForbidden', { name: playerName })
          : err instanceof Error
            ? err.message
            : t('roster.emailUpdateFailed'),
        'error'
      );
      return;
    }

    setEmailEditMember(null);
    if (resend) {
      await handleResendInvite(playerId, playerName);
    } else {
      toast.showToast(t('roster.emailUpdated'), 'success');
    }
  };

  const handleRemovePlayer = (playerId: string, playerName: string) => {
    Alert.alert(
      t('roster.removeTitle'),
      t('roster.removeBody', { name: playerName }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('guardians.remove'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removePlayer.mutateAsync({ teamId: id, playerId });
              toast.showToast(t('roster.removed'), 'success');
            } catch (err) {
              toast.showToast(err instanceof Error ? err.message : t('roster.removeFailed'), 'error');
            }
          },
        },
      ]
    );
  };

  if (isLoading || (team && !allowed)) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (error || !team) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('teams.notFound')}
        onRetry={refetch}
        onBack={goBack}
      />
    );
  }

  const members = team.members || [];
  const memberIds = new Set(members.map((m) => m.playerId));
  // Group invitation rows once per render (not per row) and share one clock
  const invitationsByPlayer = new Map<string, NonNullable<typeof team.invitations>>();
  for (const row of team.invitations ?? []) {
    const bucket = invitationsByPlayer.get(row.playerId);
    if (bucket) {
      bucket.push(row);
    } else {
      invitationsByPlayer.set(row.playerId, [row]);
    }
  }
  const statusNow = new Date();
  // Case-3 rows: pending invites for accounts not yet rostered, deduped
  // against members (rostered players get their chip from the team payload).
  const pendingNonMemberInvites = (teamInvitationsData?.invitations || []).filter(
    (inv) =>
      // status re-check is deliberate defense against a stale cached page from
      // an unfiltered query (the hook scopes to PENDING, the cache may not)
      inv.status === 'PENDING' &&
      !memberIds.has(inv.playerId) &&
      !isInvitationExpired(inv.expiresAt)
  );
  // Players who already have a live invitation must not resurface in search —
  // re-selecting one there would hit a bare 400 ("pending invitation already
  // exists"; that path doesn't supersede). Resend lives on their Invited row.
  const pendingInviteePlayerIds = new Set(pendingNonMemberInvites.map((inv) => inv.playerId));

  /**
   * Per-player actions live behind one 44pt overflow button (design review:
   * five inline icons crowded the title to nothing on small screens, missed
   * touch-target minimums, and paired two near-identical mail glyphs with
   * opposite meanings). Rendered as an ActionMenu bottom sheet — Android caps
   * Alert at three buttons, which would truncate this menu. Items derive from
   * LIVE state at render time (no stale snapshot in a callback).
   */
  const menuItemsFor = (
    member: (typeof members)[number],
    { status, pendingInvitation }: RosterStatusResult
  ): ActionMenuItem[] => {
    const playerName = displayName(member.player);
    const items: ActionMenuItem[] = [];

    // A deleted account (#444) is a tombstone: nothing to invite or edit,
    // only Remove from team (which never touches stats).
    if (status === 'deleted') {
      items.push({
        label: t('roster.menu.remove'),
        destructive: true,
        onPress: () => handleRemovePlayer(member.playerId, playerName),
      });
      return items;
    }

    // First, because it is why the invitations below are not arriving. Only
    // an unclaimed (managed) player's address is the coach's to change; a
    // claimed account's email belongs to its login (#449).
    if (getEmailDeliveryIssue(member.player) && member.player.isManaged) {
      items.push({
        label: t('roster.menu.fixEmail'),
        onPress: () => openEmailEdit(member),
      });
    }

    if (status === 'invited' || status === 'invite_expired') {
      items.push({
        label: t('roster.menu.resend'),
        onPress: () => handleResendInvite(member.playerId, playerName),
      });
    } else if (status === 'not_invited' && member.player.email) {
      // A never/no-longer-invited player needs an address on file
      items.push({
        label: t('roster.menu.send'),
        onPress: () => handleResendInvite(member.playerId, playerName),
      });
    }
    if (status === 'invited' && pendingInvitation) {
      items.push({
        label: t('roster.cancelInvitation'),
        onPress: () => handleCancelInvite(pendingInvitation.id, playerName),
      });
    }
    if (member.player.isManaged) {
      items.push({
        label: t('guardians.inviteParent'),
        onPress: () => router.push(`/teams/${id}/players/${member.playerId}/guardians`),
      });
    }
    items.push({
      label: t('roster.menu.editDetails'),
      onPress: () => openMemberEdit(member),
    });
    items.push({
      label: t('roster.menu.remove'),
      destructive: true,
      onPress: () => handleRemovePlayer(member.playerId, playerName),
    });
    return items;
  };

  const renderMemberRow = (member: (typeof members)[number]) => {
    const rosterStatus = getRosterStatus(
      member,
      invitationsByPlayer.get(member.playerId),
      statusNow
    );
    const details = [
      member.jerseyNumber != null && `#${member.jerseyNumber}`,
      member.position,
    ]
      .filter(Boolean)
      .join(' • ');
    const emailIssue = getEmailDeliveryIssue(member.player);
    const subtitle = details || member.player.email || undefined;

    const row = (
      <ListItem
        key={member.id}
        title={displayName(member.player)}
        subtitle={subtitle}
        // A flagged row continues into the strip below; the strip draws the divider.
        style={emailIssue ? styles.rowWithIssue : undefined}
        leftElement={
          member.player.isManaged ? (
            <Ionicons name="person-outline" size={20} color={colors.textTertiary} />
          ) : undefined
        }
        rightElement={
          <View style={styles.rowActions}>
            <StatusChip
              status={rosterStatus.status}
              playerName={displayName(member.player)}
              colors={colors}
            />
            <TouchableOpacity
              onPress={() => setMenuForPlayerId(member.playerId)}
              accessibilityRole="button"
              accessibilityLabel={t('roster.optionsA11y', { name: displayName(member.player) })}
              style={styles.rowButton}
            >
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        }
      />
    );

    if (!emailIssue) return row;

    // The address gets a full-width line of its own: it is what the coach has
    // to read, and beside the chips it truncated to "xander.ex…" on a phone.
    // A very long address loses its middle, keeping the name and the domain.
    return (
      <View key={member.id}>
        {row}
        <View
          style={[
            styles.issueStrip,
            { paddingHorizontal: rowPadding, borderBottomColor: colors.border },
          ]}
        >
          <EmailIssueChip
            issue={emailIssue}
            playerName={displayName(member.player)}
            color={colors.error}
          />
          <ThemedText
            variant="caption"
            color="textSecondary"
            style={styles.issueAddress}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {member.player.email}
          </ThemedText>
        </View>
      </View>
    );
  };

  const renderPendingInviteRow = (invitation: TeamInvitation) => (
    <ListItem
      key={invitation.id}
      title={displayName(invitation.player)}
      subtitle={invitation.player.email || undefined}
      leftElement={<Ionicons name="hourglass-outline" size={20} color={colors.textTertiary} />}
      rightElement={
        <View style={styles.rowActions}>
          <TouchableOpacity
            onPress={() => handleResendInvite(invitation.playerId, displayName(invitation.player))}
            accessibilityRole="button"
            accessibilityLabel={t('roster.resendA11y', { name: displayName(invitation.player) })}
            style={styles.rowButton}
            disabled={createInvitation.isPending}
          >
            <Ionicons name="mail-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleCancelInvite(invitation.id, displayName(invitation.player))}
            accessibilityRole="button"
            accessibilityLabel={t('roster.cancelA11y', { name: displayName(invitation.player) })}
            style={styles.rowButton}
            disabled={cancelInvitation.isPending}
          >
            <Ionicons name="close-outline" size={22} color={colors.error} />
          </TouchableOpacity>
        </View>
      }
    />
  );

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header with back button */}
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
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <View style={styles.headerContent}>
          <ThemedText variant="h2" heading style={styles.headerTitle}>
            {t('teams.roster')}
          </ThemedText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { padding, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >

        {/* Add Player card */}
        <Card variant="elevated" style={styles.formCard}>
          <ThemedText variant="h4" heading style={styles.formTitle}>
            {showAddForm ? t('teams.addPlayer') : t('roster.invitePlayer')}
          </ThemedText>

          {!showAddForm ? (
            <>
              {/* Search for an existing account */}
              <Input
                label={t('roster.searchLabel')}
                placeholder={t('roster.searchPlaceholder')}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                leftIcon={<Ionicons name="search-outline" size={20} color={colors.textTertiary} />}
              />

              {searchQuery && (
                <View style={styles.searchResults}>
                  {searchingPlayers ? (
                    <ThemedText variant="caption" color="textTertiary" style={styles.searchText}>
                      {t('roster.searching')}
                    </ThemedText>
                  ) : players.length > 0 ? (
                    players
                      .filter((p) => !memberIds.has(p.id) && !pendingInviteePlayerIds.has(p.id))
                      .map((player) => (
                        <ListItem
                          key={player.id}
                          title={displayName(player)}
                          subtitle={player.email || undefined}
                          onPress={() => {
                            setSelectedPlayer(player);
                            setSearchQuery('');
                          }}
                          rightElement={
                            selectedPlayer?.id === player.id ? (
                              <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
                            ) : (
                              <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                            )
                          }
                          style={[
                            styles.playerOption,
                            selectedPlayer?.id === player.id && {
                              backgroundColor: colors.backgroundSecondary,
                            },
                          ]}
                        />
                      ))
                  ) : (
                    <ThemedText variant="caption" color="textTertiary" style={styles.searchText}>
                      {t('roster.noPlayersFound')}
                    </ThemedText>
                  )}
                </View>
              )}

              {selectedPlayer && (
                <Card variant="default" style={styles.selectedPlayerCard}>
                  <View style={styles.selectedPlayerInfo}>
                    <Ionicons name="person-circle" size={40} color={colors.primary} />
                    <View style={styles.selectedPlayerDetails}>
                      <ThemedText variant="bodyBold">{displayName(selectedPlayer)}</ThemedText>
                      <ThemedText variant="caption" color="textSecondary">
                        {selectedPlayer.email || t('teams.rosterPlayer')}
                      </ThemedText>
                    </View>
                    <TouchableOpacity
                      onPress={() => setSelectedPlayer(null)}
                      style={styles.clearSelection}
                      hitSlop={CLEAR_SELECTION_HIT_SLOP}
                      accessibilityRole="button"
                      accessibilityLabel={t('players.clearSelectedPlayer')}
                    >
                      <Ionicons name="close-circle" size={CLEAR_SELECTION_ICON_SIZE} color={colors.textTertiary} />
                    </TouchableOpacity>
                  </View>
                </Card>
              )}

              {selectedPlayer && (
                <>
                  <Input
                    label={t('players.jerseyNumber')}
                    placeholder={t('roster.jerseyPlaceholder')}
                    value={jerseyNumber}
                    onChangeText={(text) => setJerseyNumber(text.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    maxLength={2}
                  />

                  <Input
                    label={t('players.position')}
                    placeholder={t('roster.positionPlaceholder')}
                    value={position}
                    onChangeText={setPosition}
                    autoCapitalize="words"
                  />
                </>
              )}

              <View style={styles.actionButtons}>
                {selectedPlayer ? (
                  <Button
                    title={t('roster.sendInvitation')}
                    onPress={handleInviteSelectedPlayer}
                    loading={createInvitation.isPending}
                    fullWidth
                  />
                ) : (
                  <Button
                    title={t('teams.addPlayer')}
                    variant="outline"
                    onPress={() => setShowAddForm(true)}
                    fullWidth
                    testID="add-player-button"
                  />
                )}
              </View>
            </>
          ) : (
            <>
              {/* Unified Add Player form — email decides whether an invite
                  goes out; the player is on the roster either way. */}
              <View style={styles.avatarRow}>
                <AvatarPicker
                  uri={avatarUri}
                  name={name}
                  onImageSelected={setAvatarUri}
                  menuTitle={t('players.playerPhoto')}
                />
              </View>

              <Input
                label={t('players.name')}
                placeholder={t('roster.namePlaceholder')}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                testID="add-player-name-input"
              />

              <Input
                label={t('roster.playerEmailLabel')}
                placeholder={t('roster.playerEmailPlaceholder')}
                value={playerEmail}
                onChangeText={setPlayerEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                testID="add-player-email-input"
              />

              <Input
                label={t('players.jerseyNumber')}
                placeholder={t('roster.jerseyPlaceholder')}
                value={jerseyNumber}
                onChangeText={(text) => setJerseyNumber(text.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                maxLength={2}
                testID="add-player-jersey-input"
              />

              <Input
                label={t('players.position')}
                placeholder={t('roster.positionPlaceholder')}
                value={position}
                onChangeText={setPosition}
                autoCapitalize="words"
              />

              <Input
                label={t('roster.guardianEmailLabel')}
                placeholder={t('roster.guardianEmailPlaceholder')}
                value={guardianEmail}
                onChangeText={setGuardianEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                testID="add-player-guardian-email-input"
              />

              {guardianEmail.trim() !== '' && (
                <>
                  <ThemedText variant="captionBold" style={styles.relationshipLabel}>
                    {t('guardians.relationshipLabel')}
                  </ThemedText>
                  <RelationshipChips
                    value={guardianRelationship}
                    onChange={setGuardianRelationship}
                  />
                </>
              )}

              <View style={styles.actionButtons}>
                <Button
                  title={uploadingAvatar ? t('roster.uploadingPhoto') : t('teams.addPlayer')}
                  onPress={handleAddPlayer}
                  loading={addRosterPlayer.isPending || uploadingAvatar}
                  disabled={!name.trim()}
                  fullWidth
                  testID="add-player-submit"
                />
                <Button
                  title={t('common.cancel')}
                  variant="outline"
                  onPress={resetAddForm}
                  style={styles.cancelButton}
                  fullWidth
                />
              </View>
            </>
          )}
        </Card>

        {/* Current Players */}
        <View style={styles.section}>
          <ThemedText variant="h4" heading style={styles.sectionTitle}>
            {t('roster.currentPlayers', { count: members.length })}
          </ThemedText>

          {members.length === 0 ? (
            <Card variant="default" style={styles.emptyCard}>
              <ThemedText variant="body" color="textTertiary" style={styles.emptyText}>
                {t('teams.noPlayersYet')}
              </ThemedText>
            </Card>
          ) : (
            <Card variant="default" style={styles.playersCard}>
              {members.map(renderMemberRow)}
            </Card>
          )}
        </View>

        {/* Invited, not yet on the roster (existing accounts, case 3). A
            failed fetch must not silently drop the section — a coach who
            can't see a live invite tends to re-invite and hit a 400. */}
        {teamInvitationsError != null && (
          <View style={styles.section}>
            <ThemedText variant="h4" heading style={styles.sectionTitle}>
              {t('roster.invitedHeading')}
            </ThemedText>
            <Card variant="default" style={styles.playersCard}>
              <View style={styles.inviteErrorRow}>
                <ThemedText variant="caption" color="textSecondary">
                  {t('roster.invitationsLoadFailed')}
                </ThemedText>
                <TouchableOpacity
                  onPress={() => refetchTeamInvitations()}
                  accessibilityRole="button"
                  accessibilityLabel={t('roster.retryInvitationsA11y')}
                >
                  <ThemedText variant="captionBold" style={{ color: colors.primary }}>
                    {t('roster.retry')}
                  </ThemedText>
                </TouchableOpacity>
              </View>
            </Card>
          </View>
        )}
        {pendingNonMemberInvites.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h4" heading style={styles.sectionTitle}>
              {t('roster.invitedCount', { count: pendingNonMemberInvites.length })}
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" style={styles.sectionHint}>
              {t('roster.invitedHint')}
            </ThemedText>
            <Card variant="default" style={styles.playersCard}>
              {pendingNonMemberInvites.map(renderPendingInviteRow)}
            </Card>
          </View>
        )}
      </ScrollView>

      {(() => {
        const menuMember = members.find((m) => m.playerId === menuForPlayerId);
        if (!menuMember) return null;
        return (
          <ActionMenu
            visible
            title={displayName(menuMember.player)}
            items={menuItemsFor(
              menuMember,
              getRosterStatus(menuMember, invitationsByPlayer.get(menuMember.playerId), statusNow)
            )}
            onClose={() => setMenuForPlayerId(null)}
          />
        );
      })()}

      {/* Jersey/position edit sheet (same bottom-sheet idiom as ActionMenu).
          Clearing an input clears the stored value — the API takes null. */}
      <Modal
        visible={editingMember != null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingMember(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.editBackdropContainer}
        >
          <Pressable
            style={styles.editBackdrop}
            onPress={() => setEditingMember(null)}
            accessibilityRole="button"
            accessibilityLabel={t('roster.closeEditA11y')}
          />
          <View
            style={[
              styles.editSheet,
              {
                backgroundColor: colors.background,
                paddingBottom: insets.bottom + spacing.md,
              },
            ]}
          >
            <ThemedText variant="h4" heading style={styles.editTitle}>
              {editingMember ? t('roster.editTitle', { name: displayName(editingMember.player) }) : ''}
            </ThemedText>
            <Input
              label={t('players.jerseyNumber')}
              placeholder={t('roster.jerseyClearPlaceholder')}
              value={editJersey}
              onChangeText={(text) => setEditJersey(text.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              maxLength={2}
              testID="edit-member-jersey-input"
            />
            <Input
              label={t('players.position')}
              placeholder={t('roster.positionPlaceholder')}
              value={editPosition}
              onChangeText={setEditPosition}
              autoCapitalize="words"
              testID="edit-member-position-input"
            />
            <Button
              title={t('common.save')}
              onPress={handleSaveMemberEdit}
              loading={updateTeamMember.isPending}
              fullWidth
              testID="edit-member-save"
            />
            <Button
              title={t('common.cancel')}
              variant="outline"
              onPress={() => setEditingMember(null)}
              style={styles.cancelButton}
              fullWidth
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Fix-email sheet (#449): same bottom-sheet idiom as the edit sheet.
          The status is derived from LIVE state, like the ActionMenu items. */}
      {(() => {
        const liveMember = members.find((m) => m.playerId === emailEditMember?.playerId);
        const issue = liveMember ? getEmailDeliveryIssue(liveMember.player) : null;
        const awaitingInvite =
          !!liveMember &&
          AWAITING_INVITE.has(
            getRosterStatus(liveMember, invitationsByPlayer.get(liveMember.playerId), statusNow).status
          );
        const saving = updatePlayer.isPending || createInvitation.isPending;
        return (
          <Modal
            visible={emailEditMember != null}
            transparent
            animationType="fade"
            onRequestClose={() => setEmailEditMember(null)}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.editBackdropContainer}
            >
              <Pressable
                style={styles.editBackdrop}
                onPress={() => setEmailEditMember(null)}
                accessibilityRole="button"
                accessibilityLabel={t('roster.closeEmailEditA11y')}
              />
              <View
                style={[
                  styles.editSheet,
                  {
                    backgroundColor: colors.background,
                    paddingBottom: insets.bottom + spacing.md,
                  },
                ]}
              >
                <ThemedText variant="h4" heading style={styles.editTitle}>
                  {emailEditMember ? t('roster.emailForTitle', { name: displayName(emailEditMember.player) }) : ''}
                </ThemedText>
                {issue && (
                  <ThemedText variant="caption" color="textSecondary" style={styles.editHint}>
                    {emailDeliveryIssueExplanation(issue)}
                  </ThemedText>
                )}
                <Input
                  label={t('roster.emailLabel')}
                  placeholder={t('roster.emailPlaceholder')}
                  value={editEmail}
                  onChangeText={setEditEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="edit-player-email-input"
                />
                <Button
                  title={awaitingInvite ? t('roster.saveAndSend') : t('common.save')}
                  onPress={() => handleSaveEmail(awaitingInvite)}
                  loading={saving}
                  disabled={!canSaveEmail || saving}
                  fullWidth
                  testID="edit-player-email-save"
                />
                <Button
                  title={t('common.cancel')}
                  variant="outline"
                  onPress={() => setEmailEditMember(null)}
                  style={styles.cancelButton}
                  fullWidth
                />
              </View>
            </KeyboardAvoidingView>
          </Modal>
        );
      })()}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // BackButton draws at 40pt (this header's arrow was 32pt with 8pt after it):
  // pulled left 4pt with no right margin, the arrow and the title stay put.
  backButton: {
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  formCard: {
    marginBottom: spacing.xl,
  },
  formTitle: {
    marginBottom: spacing.md,
  },
  section: {
    marginTop: spacing.md,
  },
  sectionTitle: {
    marginBottom: spacing.xs,
  },
  sectionHint: {
    marginBottom: spacing.md,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowButton: {
    // 44pt minimum touch target (WCAG/HIG)
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowWithIssue: {
    borderBottomWidth: 0,
    paddingBottom: spacing.xs,
  },
  issueStrip: {
    // Stacked, not side by side: next to the chip a 26-character address
    // still lost its middle on a 393pt screen.
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  issueAddress: {
    alignSelf: 'stretch',
  },
  chip: {
    borderWidth: 1,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  playersCard: {
    marginTop: spacing.sm,
  },
  inviteErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
  },
  emptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    textAlign: 'center',
  },
  searchResults: {
    marginTop: spacing.sm,
    maxHeight: 200,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  searchText: {
    padding: spacing.md,
    textAlign: 'center',
  },
  playerOption: {
    marginBottom: 0,
  },
  selectedPlayerCard: {
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  selectedPlayerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  selectedPlayerDetails: {
    flex: 1,
  },
  clearSelection: {
    padding: spacing.xs,
  },
  actionButtons: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
  avatarRow: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  relationshipLabel: {
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  editBackdropContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  editBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  editSheet: {
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  editTitle: {
    marginBottom: spacing.md,
  },
  editHint: {
    marginBottom: spacing.md,
  },
});
