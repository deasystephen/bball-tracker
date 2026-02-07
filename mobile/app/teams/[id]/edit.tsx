/**
 * Edit Team screen
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView, ThemedText, Input, Button, LoadingSpinner, ErrorState, ListItem } from '../../../components';
import { useTeam, useUpdateTeam } from '../../../hooks/useTeams';
import { useLeagues } from '../../../hooks/useLeagues';
import { useSeasons } from '../../../hooks/useSeasons';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';

export default function EditTeamScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [leagueId, setLeagueId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [errors, setErrors] = useState<{ name?: string; seasonId?: string }>({});

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const { data: leagues, isLoading: leaguesLoading } = useLeagues();
  const { data: seasonsData, isLoading: seasonsLoading } = useSeasons(
    leagueId ? { leagueId, isActive: true } : undefined
  );
  const updateTeam = useUpdateTeam();

  // Get seasons for the selected league
  const seasons = useMemo(() => {
    return seasonsData?.seasons ?? [];
  }, [seasonsData]);

  // Get selected league info
  const selectedLeague = useMemo(() => {
    return leagues?.find((l) => l.id === leagueId);
  }, [leagues, leagueId]);

  // Populate form when team loads
  useEffect(() => {
    if (team) {
      setName(team.name);
      setSeasonId(team.seasonId);
      if (team.season?.league) {
        setLeagueId(team.season.league.id);
      }
    }
  }, [team]);

  // Reset season when league changes (but not on initial load)
  const handleLeagueSelect = (id: string) => {
    if (id !== leagueId) {
      setLeagueId(id);
      // Only reset seasonId if we're changing to a different league
      if (team?.season?.league?.id !== id) {
        setSeasonId('');
      }
    }
  };

  const validate = (): boolean => {
    const newErrors: { name?: string; seasonId?: string } = {};

    if (!name.trim()) {
      newErrors.name = 'Team name is required';
    }

    if (!seasonId) {
      newErrors.seasonId = 'Season is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    try {
      await updateTeam.mutateAsync({
        teamId: id,
        data: {
          name: name.trim(),
          seasonId,
        },
      });

      Alert.alert(t('common.success'), 'Team updated successfully', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (error) {
      Alert.alert(
        t('common.error'),
        error instanceof Error ? error.message : 'Failed to update team'
      );
    }
  };

  if (isLoading || leaguesLoading) {
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
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2" style={styles.headerTitle}>
            Edit Team
          </ThemedText>
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { padding, paddingBottom: insets.bottom + spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled"
        >

          <Input
            label={t('teams.name')}
            placeholder="Enter team name"
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
          />

          {/* League Selection */}
          <View style={styles.selectionSection}>
            <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
              {t('teams.league')}
            </ThemedText>
            {leagues && leagues.length > 0 ? (
              <View style={[styles.selectionList, { borderColor: colors.border }]}>
                {leagues.map((league, index) => {
                  const isSelected = leagueId === league.id;
                  const isLast = index === leagues.length - 1;
                  return (
                    <ListItem
                      key={league.id}
                      title={league.name}
                      subtitle={
                        league._count?.seasons
                          ? `${league._count.seasons} season${league._count.seasons === 1 ? '' : 's'}`
                          : 'No seasons'
                      }
                      onPress={() => handleLeagueSelect(league.id)}
                      rightElement={
                        isSelected ? (
                          <Ionicons
                            name="checkmark-circle"
                            size={24}
                            color={colors.primary}
                          />
                        ) : (
                          <Ionicons
                            name="ellipse-outline"
                            size={24}
                            color={colors.textTertiary}
                          />
                        )
                      }
                      style={[
                        styles.selectionItem,
                        isSelected && { backgroundColor: colors.backgroundSecondary },
                        isLast && styles.lastItem,
                      ]}
                    />
                  );
                })}
              </View>
            ) : (
              <ThemedText variant="caption" color="textTertiary" style={styles.noItems}>
                No leagues available
              </ThemedText>
            )}
          </View>

          {/* Season Selection - Only show when league is selected */}
          {leagueId && (
            <View style={styles.selectionSection}>
              <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
                Season
              </ThemedText>
              {seasonsLoading ? (
                <View style={styles.loadingContainer}>
                  <LoadingSpinner message="Loading seasons..." />
                </View>
              ) : seasons.length > 0 ? (
                <View style={[styles.selectionList, { borderColor: colors.border }]}>
                  {seasons.map((season, index) => {
                    const isSelected = seasonId === season.id;
                    const isLast = index === seasons.length - 1;
                    return (
                      <ListItem
                        key={season.id}
                        title={season.name}
                        subtitle={
                          season._count?.teams
                            ? `${season._count.teams} team${season._count.teams === 1 ? '' : 's'}`
                            : 'No teams yet'
                        }
                        onPress={() => setSeasonId(season.id)}
                        rightElement={
                          isSelected ? (
                            <Ionicons
                              name="checkmark-circle"
                              size={24}
                              color={colors.primary}
                            />
                          ) : (
                            <Ionicons
                              name="ellipse-outline"
                              size={24}
                              color={colors.textTertiary}
                            />
                          )
                        }
                        style={[
                          styles.selectionItem,
                          isSelected && { backgroundColor: colors.backgroundSecondary },
                          isLast && styles.lastItem,
                        ]}
                      />
                    );
                  })}
                </View>
              ) : (
                <View style={[styles.noSeasonsContainer, { backgroundColor: colors.backgroundSecondary }]}>
                  <Ionicons name="calendar-outline" size={32} color={colors.textTertiary} />
                  <ThemedText variant="body" color="textTertiary" style={styles.noSeasonsText}>
                    No active seasons in {selectedLeague?.name}
                  </ThemedText>
                </View>
              )}
              {errors.seasonId && (
                <ThemedText variant="footnote" color="error" style={styles.errorText}>
                  {errors.seasonId}
                </ThemedText>
              )}
            </View>
          )}

          <View style={styles.buttonContainer}>
            <Button
              title={t('common.save')}
              onPress={handleSubmit}
              loading={updateTeam.isPending}
              disabled={!name.trim() || !seasonId}
              fullWidth
            />
            <Button
              title={t('common.cancel')}
              variant="outline"
              onPress={() => router.back()}
              style={styles.cancelButton}
              fullWidth
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
    padding: spacing.sm,
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.lg,
  },
  selectionSection: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  selectionList: {
    marginTop: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  selectionItem: {
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  lastItem: {
    borderBottomWidth: 0,
  },
  noItems: {
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  loadingContainer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  noSeasonsContainer: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: 8,
    alignItems: 'center',
    gap: spacing.sm,
  },
  noSeasonsText: {
    textAlign: 'center',
  },
  errorText: {
    marginTop: spacing.xs,
  },
  buttonContainer: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  cancelButton: {
    marginTop: spacing.sm,
  },
});
