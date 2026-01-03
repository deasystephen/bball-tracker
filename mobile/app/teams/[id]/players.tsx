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

  const [playerId, setPlayerId] = useState('');
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [position, setPosition] = useState('');

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const addPlayer = useAddPlayerToTeam();
  const removePlayer = useRemovePlayerFromTeam();

  const handleAddPlayer = async () => {
    if (!playerId.trim()) {
      Alert.alert('Error', 'Player ID is required');
      return;
    }

    try {
      await addPlayer.mutateAsync({
        teamId: id,
        data: {
          playerId: playerId.trim(),
          jerseyNumber: jerseyNumber ? parseInt(jerseyNumber, 10) : undefined,
          position: position.trim() || undefined,
        },
      });

      setPlayerId('');
      setJerseyNumber('');
      setPosition('');
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

          <Input
            label="Player ID"
            placeholder="Enter player user ID"
            value={playerId}
            onChangeText={setPlayerId}
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

          <Button
            title={t('players.addToTeam')}
            onPress={handleAddPlayer}
            loading={addPlayer.isPending}
            disabled={!playerId.trim()}
            fullWidth
          />
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
});
