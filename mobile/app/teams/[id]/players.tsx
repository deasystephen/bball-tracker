/**
 * Manage Players screen - Add/remove players from team
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  FlatList,
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
} from '../../../components';
import {
  useTeam,
  useAddPlayerToTeam,
  useRemovePlayerFromTeam,
} from '../../../hooks/useTeams';
import {
  usePlayers,
  useCreatePlayer,
  usePlayer,
  type Player,
} from '../../../hooks/usePlayers';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../../store/auth-store';

export default function ManagePlayersScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const { user } = useAuthStore();
  const insets = useSafeAreaInsets();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerEmail, setNewPlayerEmail] = useState('');
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [position, setPosition] = useState('');

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const addPlayer = useAddPlayerToTeam();
  const removePlayer = useRemovePlayerFromTeam();
  const createPlayer = useCreatePlayer();

  // Search for players
  const { data: playersData, isLoading: searchingPlayers } = usePlayers({
    search: searchQuery || undefined,
    role: 'PLAYER',
    limit: 10,
  });

  const players = playersData?.players || [];

  const handleCreateAndAddPlayer = async () => {
    if (!newPlayerName.trim() || !newPlayerEmail.trim()) {
      Alert.alert('Error', 'Name and email are required');
      return;
    }

    try {
      // Create the player first
      const newPlayerResult = await createPlayer.mutateAsync({
        name: newPlayerName.trim(),
        email: newPlayerEmail.trim(),
      });

      // Then add to team
      await addPlayer.mutateAsync({
        teamId: id,
        data: {
          playerId: newPlayerResult.player.id,
          jerseyNumber: jerseyNumber ? parseInt(jerseyNumber, 10) : undefined,
          position: position.trim() || undefined,
        },
      });

      // Reset form
      setNewPlayerName('');
      setNewPlayerEmail('');
      setJerseyNumber('');
      setPosition('');
      setShowCreateForm(false);
      setSearchQuery('');
      setSelectedPlayer(null);
      Alert.alert('Success', 'Player created and added to team');
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to create and add player'
      );
    }
  };

  const handleAddSelectedPlayer = async () => {
    if (!selectedPlayer) {
      Alert.alert('Error', 'Please select a player');
      return;
    }

    try {
      await addPlayer.mutateAsync({
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
      Alert.alert('Success', 'Player added to team');
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to add player'
      );
    }
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
              Alert.alert('Success', 'Player removed from team');
            } catch (error) {
              Alert.alert(
                'Error',
                error instanceof Error ? error.message : 'Failed to remove player'
              );
            }
          },
        },
      ]
    );
  };

  if (isLoading) {
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

        {/* Add Player Form */}
        <Card variant="elevated" style={styles.formCard}>
          <ThemedText variant="h4" style={styles.formTitle}>
            Add Player
          </ThemedText>

          {!showCreateForm ? (
            <>
              {/* Search for existing player */}
              <Input
                label="Search Players"
                placeholder="Search by name or email..."
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                leftIcon={<Ionicons name="search-outline" size={20} color={colors.textTertiary} />}
              />

              {/* Player search results */}
              {searchQuery && (
                <View style={styles.searchResults}>
                  {searchingPlayers ? (
                    <ThemedText variant="caption" color="textTertiary" style={styles.searchText}>
                      Searching...
                    </ThemedText>
                  ) : players.length > 0 ? (
                    players
                      .filter((p) => {
                        // Filter out players already on the team
                        return !members.some((m) => m.playerId === p.id);
                      })
                      .map((player) => (
                        <ListItem
                          key={player.id}
                          title={player.name}
                          subtitle={player.email}
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

              {/* Selected player info */}
              {selectedPlayer && (
                <Card variant="default" style={styles.selectedPlayerCard}>
                  <View style={styles.selectedPlayerInfo}>
                    <Ionicons name="person-circle" size={40} color={colors.primary} />
                    <View style={styles.selectedPlayerDetails}>
                      <ThemedText variant="bodyBold">{selectedPlayer.name}</ThemedText>
                      <ThemedText variant="caption" color="textSecondary">
                        {selectedPlayer.email}
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

              {/* Jersey and Position (shown when player selected or creating) */}
              {(selectedPlayer || showCreateForm) && (
                <>
                  <Input
                    label={t('players.jerseyNumber')}
                    placeholder="e.g., 23"
                    value={jerseyNumber}
                    onChangeText={setJerseyNumber}
                    keyboardType="number-pad"
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

              {/* Action buttons */}
              <View style={styles.actionButtons}>
                {selectedPlayer ? (
                  <Button
                    title="Add Selected Player"
                    onPress={handleAddSelectedPlayer}
                    loading={addPlayer.isPending}
                    fullWidth
                  />
                ) : (
                  <Button
                    title="Create New Player"
                    variant="outline"
                    onPress={() => setShowCreateForm(true)}
                    fullWidth
                  />
                )}
              </View>
            </>
          ) : (
            <>
              {/* Create new player form */}
              <Input
                label="Player Name"
                placeholder="Enter player name"
                value={newPlayerName}
                onChangeText={setNewPlayerName}
                autoCapitalize="words"
              />

              <Input
                label="Email"
                placeholder="Enter email address"
                value={newPlayerEmail}
                onChangeText={setNewPlayerEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />

              <Input
                label={t('players.jerseyNumber')}
                placeholder="e.g., 23"
                value={jerseyNumber}
                onChangeText={setJerseyNumber}
                keyboardType="number-pad"
              />

              <Input
                label={t('players.position')}
                placeholder="e.g., Forward, Guard"
                value={position}
                onChangeText={setPosition}
                autoCapitalize="words"
              />

              <View style={styles.actionButtons}>
                <Button
                  title="Create & Add to Team"
                  onPress={handleCreateAndAddPlayer}
                  loading={createPlayer.isPending || addPlayer.isPending}
                  disabled={!newPlayerName.trim() || !newPlayerEmail.trim()}
                  fullWidth
                />
                <Button
                  title="Cancel"
                  variant="outline"
                  onPress={() => {
                    setShowCreateForm(false);
                    setNewPlayerName('');
                    setNewPlayerEmail('');
                    setJerseyNumber('');
                    setPosition('');
                  }}
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
              {members.map((member) => (
                <ListItem
                  key={member.id}
                  title={member.player.name}
                  subtitle={
                    [
                      member.jerseyNumber && `#${member.jerseyNumber}`,
                      member.position,
                    ]
                      .filter(Boolean)
                      .join(' • ') || member.player.email
                  }
                  rightElement={
                    <TouchableOpacity
                      onPress={() =>
                        handleRemovePlayer(member.playerId, member.player.name)
                      }
                    >
                      <Ionicons name="close-circle" size={24} color={colors.error} />
                    </TouchableOpacity>
                  }
                />
              ))}
            </Card>
          )}
        </View>
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
    marginBottom: spacing.md,
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
});
