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
  hasTeamPermission,
  type AddRosterPlayerResponse,
} from '../../../hooks/useTeams';
import {
  useCreateInvitation,
  useCancelInvitation,
  useTeamInvitations,
  type TeamInvitation,
} from '../../../hooks/useInvitations';
import { usePlayers, type Player } from '../../../hooks/usePlayers';
import {
  getRosterStatus,
  rosterStatusLabel,
  rosterStatusColor,
  type RosterStatus,
} from '../../../utils/roster-status';
import { isInvitationExpired } from '../../../utils/invitation-expiry';
import { GUARDIAN_RELATIONSHIPS, relationshipLabel } from '../../../utils/guardian';
import type { GuardianRelationship } from '../../../../shared/types';
import { useToast } from '../../../components/Toast';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { uploadAvatar } from '../../../services/upload-service';
import { useAccessGuard } from '../../../hooks/useAccessGuard';
import { useAuthUser } from '../../../store/auth-store';

interface ChipPalette {
  success: string;
  primary: string;
  warning: string;
  textSecondary: string;
}

function StatusChip({ status, colors }: { status: RosterStatus; colors: ChipPalette }) {
  const color = rosterStatusColor(status, colors);
  return (
    <View
      style={[styles.chip, { borderColor: color }]}
      accessibilityLabel={`Status: ${rosterStatusLabel(status)}`}
    >
      <ThemedText variant="caption" style={{ color }}>
        {rosterStatusLabel(status)}
      </ThemedText>
    </View>
  );
}

export default function ManagePlayersScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
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

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const removePlayer = useRemovePlayerFromTeam();
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
  const { data: teamInvitationsData } = useTeamInvitations(id, 'PENDING');

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
      toast.showToast(
        "This email already has an account — invitation sent. They'll appear on the roster once they accept.",
        'info'
      );
    } else if (result.invited) {
      toast.showToast('Player added to roster and invitation sent', 'success');
    } else {
      toast.showToast('Player added to roster', 'success');
    }

    if (result.emails.player === false) {
      toast.showToast(
        'The invitation email failed to send — use Resend on the roster to retry.',
        'error'
      );
    }
    if (hadGuardianEmail) {
      if (!result.guardianInvited && result.guardianReason) {
        toast.showToast(result.guardianReason, 'info');
      } else if (result.emails.guardian === false) {
        toast.showToast('The parent invite email failed to send — retry from the player’s Guardians screen.', 'error');
      }
    }
  };

  const handleAddPlayer = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Player name is required');
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
      toast.showToast(
        err instanceof Error ? err.message : 'Failed to add player',
        'error'
      );
    }
  };

  const handleInviteSelectedPlayer = async () => {
    if (!selectedPlayer) {
      Alert.alert('Error', 'Please select a player');
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
      toast.showToast('Invitation sent to player', 'success');
      if (response.emailSent === false) {
        toast.showToast('The invitation email failed to send — use Resend to retry.', 'error');
      }
    } catch (err) {
      toast.showToast(
        err instanceof Error ? err.message : 'Failed to send invitation',
        'error'
      );
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
        toast.showToast(`Invitation refreshed, but the email to ${playerName} failed to send.`, 'error');
      } else if (response.emailSent === null) {
        toast.showToast(`${playerName} has no email address on file.`, 'info');
      } else {
        toast.showToast(`Invitation re-sent to ${playerName}`, 'success');
      }
    } catch (err) {
      toast.showToast(
        err instanceof Error ? err.message : 'Failed to resend invitation',
        'error'
      );
    }
  };

  const handleCancelInvite = (invitationId: string, playerName: string) => {
    Alert.alert(
      'Cancel Invitation',
      `Cancel the pending invitation for ${playerName}? They stay on the roster and can be re-invited later.`,
      [
        { text: 'Keep invitation', style: 'cancel' },
        {
          text: 'Cancel invitation',
          style: 'destructive',
          onPress: async () => {
            try {
              await cancelInvitation.mutateAsync({ invitationId, teamId: id });
              toast.showToast('Invitation cancelled', 'success');
            } catch (err) {
              toast.showToast(
                err instanceof Error ? err.message : 'Failed to cancel invitation',
                'error'
              );
            }
          },
        },
      ]
    );
  };

  const handleRemovePlayer = (playerId: string, playerName: string) => {
    Alert.alert(
      'Remove Player',
      `Remove ${playerName} from the team?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removePlayer.mutateAsync({ teamId: id, playerId });
              toast.showToast('Player removed from team', 'success');
            } catch (err) {
              toast.showToast(
                err instanceof Error ? err.message : 'Failed to remove player',
                'error'
              );
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
        message={error instanceof Error ? error.message : 'Team not found'}
        onRetry={refetch}
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
      inv.status === 'PENDING' &&
      !memberIds.has(inv.playerId) &&
      !isInvitationExpired(inv.expiresAt)
  );

  const renderMemberRow = (member: (typeof members)[number]) => {
    const { status, pendingInvitation } = getRosterStatus(
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
    const subtitle = details || member.player.email || undefined;
    const canResend = status === 'invited' || status === 'invite_expired';
    // "Invite" for a never/no-longer-invited player needs an address on file
    const canInvite = status === 'not_invited' && !!member.player.email;

    return (
      <ListItem
        key={member.id}
        title={member.player.name}
        subtitle={subtitle}
        leftElement={
          member.player.isManaged ? (
            <Ionicons name="person-outline" size={20} color={colors.textTertiary} />
          ) : undefined
        }
        rightElement={
          <View style={styles.rowActions}>
            <StatusChip status={status} colors={colors} />
            {(canResend || canInvite) && (
              <TouchableOpacity
                onPress={() => handleResendInvite(member.playerId, member.player.name)}
                accessibilityRole="button"
                accessibilityLabel={`${canInvite ? 'Invite' : 'Resend invitation'}: ${member.player.name}`}
                style={styles.rowButton}
                disabled={createInvitation.isPending}
              >
                <Ionicons name="mail-outline" size={22} color={colors.primary} />
              </TouchableOpacity>
            )}
            {pendingInvitation && status === 'invited' && (
              <TouchableOpacity
                onPress={() => handleCancelInvite(pendingInvitation.id, member.player.name)}
                accessibilityRole="button"
                accessibilityLabel={`Cancel invitation: ${member.player.name}`}
                style={styles.rowButton}
              >
                <Ionicons name="mail-unread-outline" size={22} color={colors.warning} />
              </TouchableOpacity>
            )}
            {member.player.isManaged && (
              <TouchableOpacity
                onPress={() =>
                  router.push(`/teams/${id}/players/${member.playerId}/guardians`)
                }
                accessibilityRole="button"
                accessibilityLabel={`Invite a parent: ${member.player.name}`}
                style={styles.rowButton}
              >
                <Ionicons name="people-outline" size={22} color={colors.primary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => handleRemovePlayer(member.playerId, member.player.name)}
              accessibilityRole="button"
              accessibilityLabel={`Remove player: ${member.player.name}`}
              style={styles.rowButton}
            >
              <Ionicons name="close-circle" size={22} color={colors.error} />
            </TouchableOpacity>
          </View>
        }
      />
    );
  };

  const renderPendingInviteRow = (invitation: TeamInvitation) => (
    <ListItem
      key={invitation.id}
      title={invitation.player.name}
      subtitle={invitation.player.email || undefined}
      leftElement={<Ionicons name="hourglass-outline" size={20} color={colors.textTertiary} />}
      rightElement={
        <View style={styles.rowActions}>
          <StatusChip status="invited" colors={colors} />
          <TouchableOpacity
            onPress={() => handleResendInvite(invitation.playerId, invitation.player.name)}
            accessibilityRole="button"
            accessibilityLabel={`Resend invitation: ${invitation.player.name}`}
            style={styles.rowButton}
            disabled={createInvitation.isPending}
          >
            <Ionicons name="mail-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleCancelInvite(invitation.id, invitation.player.name)}
            accessibilityRole="button"
            accessibilityLabel={`Cancel invitation: ${invitation.player.name}`}
            style={styles.rowButton}
          >
            <Ionicons name="mail-unread-outline" size={22} color={colors.warning} />
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
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" style={styles.headerTitle}>
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
          <ThemedText variant="h4" style={styles.formTitle}>
            {showAddForm ? 'Add Player' : 'Invite Player'}
          </ThemedText>

          {!showAddForm ? (
            <>
              {/* Search for an existing account */}
              <Input
                label="Search Players"
                placeholder="Search by name or email..."
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                leftIcon={<Ionicons name="search-outline" size={20} color={colors.textTertiary} />}
              />

              {searchQuery && (
                <View style={styles.searchResults}>
                  {searchingPlayers ? (
                    <ThemedText variant="caption" color="textTertiary" style={styles.searchText}>
                      Searching...
                    </ThemedText>
                  ) : players.length > 0 ? (
                    players
                      .filter((p) => !memberIds.has(p.id))
                      .map((player) => (
                        <ListItem
                          key={player.id}
                          title={player.name}
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
                      No players found
                    </ThemedText>
                  )}
                </View>
              )}

              {selectedPlayer && (
                <Card variant="default" style={styles.selectedPlayerCard}>
                  <View style={styles.selectedPlayerInfo}>
                    <Ionicons name="person-circle" size={40} color={colors.primary} />
                    <View style={styles.selectedPlayerDetails}>
                      <ThemedText variant="bodyBold">{selectedPlayer.name}</ThemedText>
                      <ThemedText variant="caption" color="textSecondary">
                        {selectedPlayer.email || 'Roster player'}
                      </ThemedText>
                    </View>
                    <TouchableOpacity
                      onPress={() => setSelectedPlayer(null)}
                      style={styles.clearSelection}
                    >
                      <Ionicons name="close-circle" size={24} color={colors.textTertiary} />
                    </TouchableOpacity>
                  </View>
                </Card>
              )}

              {selectedPlayer && (
                <>
                  <Input
                    label={t('players.jerseyNumber')}
                    placeholder="e.g., 23"
                    value={jerseyNumber}
                    onChangeText={(text) => setJerseyNumber(text.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    maxLength={2}
                  />

                  <Input
                    label={t('players.position')}
                    placeholder="e.g., Forward, Guard"
                    value={position}
                    onChangeText={setPosition}
                    autoCapitalize="words"
                  />
                </>
              )}

              <View style={styles.actionButtons}>
                {selectedPlayer ? (
                  <Button
                    title="Send Invitation"
                    onPress={handleInviteSelectedPlayer}
                    loading={createInvitation.isPending}
                    fullWidth
                  />
                ) : (
                  <Button
                    title="Add Player"
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
                />
              </View>

              <Input
                label="Player Name"
                placeholder="Enter player name"
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                testID="add-player-name-input"
              />

              <Input
                label="Player Email (optional)"
                placeholder="Invitation is emailed when provided"
                value={playerEmail}
                onChangeText={setPlayerEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                testID="add-player-email-input"
              />

              <Input
                label={t('players.jerseyNumber')}
                placeholder="e.g., 23"
                value={jerseyNumber}
                onChangeText={(text) => setJerseyNumber(text.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                maxLength={2}
                testID="add-player-jersey-input"
              />

              <Input
                label={t('players.position')}
                placeholder="e.g., Forward, Guard"
                value={position}
                onChangeText={setPosition}
                autoCapitalize="words"
              />

              <Input
                label="Parent/Guardian Email (optional)"
                placeholder="Invite a parent to follow this player"
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
                    Relationship
                  </ThemedText>
                  <View style={styles.chipRow}>
                    {GUARDIAN_RELATIONSHIPS.map((value) => {
                      const selected = value === guardianRelationship;
                      return (
                        <TouchableOpacity
                          key={value}
                          onPress={() => setGuardianRelationship(value)}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          accessibilityLabel={relationshipLabel(value)}
                          style={[
                            styles.relationshipChip,
                            {
                              backgroundColor: selected ? colors.primary : colors.backgroundSecondary,
                              borderColor: selected ? colors.primary : colors.border,
                            },
                          ]}
                        >
                          <ThemedText
                            variant="captionBold"
                            style={selected ? styles.chipTextSelected : undefined}
                          >
                            {relationshipLabel(value)}
                          </ThemedText>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}

              <View style={styles.actionButtons}>
                <Button
                  title={uploadingAvatar ? 'Uploading photo...' : 'Add Player'}
                  onPress={handleAddPlayer}
                  loading={addRosterPlayer.isPending || uploadingAvatar}
                  disabled={!name.trim()}
                  fullWidth
                  testID="add-player-submit"
                />
                <Button
                  title="Cancel"
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
          <ThemedText variant="h4" style={styles.sectionTitle}>
            Current Players ({members.length})
          </ThemedText>

          {members.length === 0 ? (
            <Card variant="default" style={styles.emptyCard}>
              <ThemedText variant="body" color="textTertiary" style={styles.emptyText}>
                No players added yet
              </ThemedText>
            </Card>
          ) : (
            <Card variant="default" style={styles.playersCard}>
              {members.map(renderMemberRow)}
            </Card>
          )}
        </View>

        {/* Invited, not yet on the roster (existing accounts, case 3) */}
        {pendingNonMemberInvites.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="h4" style={styles.sectionTitle}>
              Invited ({pendingNonMemberInvites.length})
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" style={styles.sectionHint}>
              These players already have accounts and join the roster when they accept.
            </ThemedText>
            <Card variant="default" style={styles.playersCard}>
              {pendingNonMemberInvites.map(renderPendingInviteRow)}
            </Card>
          </View>
        )}
      </ScrollView>
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
  backButton: {
    padding: spacing.xs,
    marginRight: spacing.sm,
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
    gap: spacing.xs,
  },
  rowButton: {
    padding: spacing.xs,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  playersCard: {
    marginTop: spacing.sm,
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
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  relationshipChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipTextSelected: {
    color: '#FFFFFF',
  },
});
