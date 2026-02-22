/**
 * Team Announcements screen - view and create announcements
 */

import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  Input,
  Button,
  LoadingSpinner,
  ErrorState,
  EmptyState,
} from '../../../components';
import { useAnnouncements, useCreateAnnouncement } from '../../../hooks/useAnnouncements';
import { useTeam, hasTeamPermission } from '../../../hooks/useTeams';
import { useAuthStore } from '../../../store/auth-store';
import { useTheme } from '../../../hooks/useTheme';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import type { Announcement } from '../../../hooks/useAnnouncements';

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHours < 1) return 'Just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffHours < 48) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function AnnouncementsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const { user } = useAuthStore();

  const [showCompose, setShowCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const { data: team } = useTeam(id);
  const { data, isLoading, error, refetch } = useAnnouncements(id);
  const createAnnouncement = useCreateAnnouncement();

  const canPost = hasTeamPermission(team, user?.id, 'canManageTeam');

  const handleSubmit = async () => {
    if (!title.trim() || !body.trim()) return;

    try {
      await createAnnouncement.mutateAsync({
        teamId: id,
        data: { title: title.trim(), body: body.trim() },
      });
      setTitle('');
      setBody('');
      setShowCompose(false);
    } catch (err) {
      Alert.alert(
        'Error',
        err instanceof Error ? err.message : 'Failed to create announcement'
      );
    }
  };

  const renderItem = ({ item }: { item: Announcement }) => (
    <Card variant="default" style={styles.announcementCard}>
      <ThemedText variant="bodyBold">{item.title}</ThemedText>
      <ThemedText variant="body" style={styles.announcementBody}>
        {item.body}
      </ThemedText>
      <View style={styles.announcementMeta}>
        <ThemedText variant="footnote" color="textTertiary">
          {item.author.name}
        </ThemedText>
        <ThemedText variant="footnote" color="textTertiary">
          {formatDate(item.createdAt)}
        </ThemedText>
      </View>
    </Card>
  );

  return (
    <ThemedView variant="background" style={styles.container}>
      {/* Header */}
      <View
        style={[
          styles.header,
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
        <ThemedText variant="h2" style={styles.headerTitle}>
          Announcements
        </ThemedText>
        {canPost && (
          <TouchableOpacity
            onPress={() => setShowCompose(!showCompose)}
            style={styles.composeButton}
            accessibilityLabel="New announcement"
          >
            <Ionicons name={showCompose ? 'close' : 'add'} size={24} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        {/* Compose Form */}
        {showCompose && (
          <View style={[styles.composeForm, { paddingHorizontal: padding }]}>
            <Input
              label="Title"
              placeholder="Announcement title"
              value={title}
              onChangeText={setTitle}
            />
            <Input
              label="Message"
              placeholder="Write your announcement..."
              value={body}
              onChangeText={setBody}
              multiline
              numberOfLines={3}
            />
            <Button
              title="Post Announcement"
              onPress={handleSubmit}
              loading={createAnnouncement.isPending}
              disabled={!title.trim() || !body.trim()}
            />
          </View>
        )}

        {/* Announcements List */}
        {isLoading ? (
          <LoadingSpinner message="Loading announcements..." fullScreen />
        ) : error ? (
          <ErrorState
            message={error instanceof Error ? error.message : 'Failed to load announcements'}
            onRetry={refetch}
          />
        ) : !data?.announcements?.length ? (
          <EmptyState
            title="No Announcements"
            message="No announcements have been posted yet."
          />
        ) : (
          <FlatList
            data={data.announcements}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={{
              padding,
              paddingBottom: insets.bottom + spacing.xl,
            }}
          />
        )}
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    padding: spacing.sm,
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerTitle: { flex: 1 },
  composeButton: { padding: spacing.sm },
  composeForm: {
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  announcementCard: {
    marginBottom: spacing.md,
  },
  announcementBody: {
    marginTop: spacing.xs,
  },
  announcementMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
});
