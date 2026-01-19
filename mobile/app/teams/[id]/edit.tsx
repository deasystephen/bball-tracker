/**
 * Edit Team screen
 */

import React, { useState, useEffect } from 'react';
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
  const [errors, setErrors] = useState<{ name?: string; leagueId?: string }>({});

  const { data: team, isLoading, error, refetch } = useTeam(id);
  const { data: leagues, isLoading: leaguesLoading } = useLeagues();
  const updateTeam = useUpdateTeam();

  // Populate form when team loads
  useEffect(() => {
    if (team) {
      setName(team.name);
      setLeagueId(team.leagueId);
    }
  }, [team]);

  const validate = (): boolean => {
    const newErrors: { name?: string; leagueId?: string } = {};

    if (!name.trim()) {
      newErrors.name = 'Team name is required';
    }

    if (!leagueId) {
      newErrors.leagueId = 'League is required';
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
          leagueId,
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

          <View style={styles.leagueSection}>
            <ThemedText variant="captionBold" color="textSecondary" style={styles.label}>
              {t('teams.league')}
            </ThemedText>
            {leagues && leagues.length > 0 ? (
              <View style={[styles.leagueList, { borderColor: colors.border }]}>
                {leagues.map((league, index) => {
                  const isSelected = leagueId === league.id;
                  const isLast = index === leagues.length - 1;
                  return (
                    <ListItem
                      key={league.id}
                      title={league.name}
                      subtitle={`${league.season} ${league.year}`}
                      onPress={() => setLeagueId(league.id)}
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
                        styles.leagueItem,
                        isSelected && { backgroundColor: colors.backgroundSecondary },
                        isLast && styles.lastItem,
                      ]}
                    />
                  );
                })}
              </View>
            ) : (
              <ThemedText variant="caption" color="textTertiary" style={styles.noLeagues}>
                No leagues available
              </ThemedText>
            )}
            {errors.leagueId && (
              <ThemedText variant="footnote" color="error" style={styles.errorText}>
                {errors.leagueId}
              </ThemedText>
            )}
          </View>

          <View style={styles.buttonContainer}>
            <Button
              title={t('common.save')}
              onPress={handleSubmit}
              loading={updateTeam.isPending}
              disabled={!name.trim() || !leagueId}
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
    padding: spacing.xs,
    marginRight: spacing.sm,
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
  leagueSection: {
    marginBottom: spacing.lg,
  },
  label: {
    marginBottom: spacing.sm,
  },
  leagueList: {
    marginTop: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  leagueItem: {
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  lastItem: {
    borderBottomWidth: 0,
  },
  noLeagues: {
    marginTop: spacing.sm,
    fontStyle: 'italic',
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
