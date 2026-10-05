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
import { useInfiniteAnnouncements, useCreateAnnouncement } from '../../../hooks/useAnnouncements';
import { useTeam, hasTeamPermission } from '../../../hooks/useTeams';
import { useAuthStore } from '../../../store/auth-store';
import { useTheme } from '../../../hooks/useTheme';
import { useTranslation } from '../../../i18n';
import { spacing } from '../../../theme';
import { getHorizontalPadding } from '../../../utils/responsive';
import { formatRelativeTime } from '../../../utils/relative-time';
import type { Announcement } from '../../../hooks/useAnnouncements';
import { displayName } from '../../../utils/display-name';
import { HEADER_ICON_HIT_SLOP } from '../../../utils/touch-target';
import { BackButton } from '../../../components/BackButton';

export default function AnnouncementsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const { user } = useAuthStore();
  const { t } = useTranslation();

  const [showCompose, setShowCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const { data: team } = useTeam(id);
  const {
    data,
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteAnnouncements(id);

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };
  const createAnnouncement = useCreateAnnouncement();

  const canPost = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);

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

  // Each card opens its thread (#34); the reply count is the list's only
  // hint of activity, the thread itself loads on the next screen.
  const renderItem = ({ item }: { item: Announcement }) => (
    <Card
      variant="default"
      style={styles.announcementCard}
      onPress={() => router.push(`/teams/${id}/announcements/${item.id}`)}
      accessibilityRole="button"
      testID={`announcement-${item.id}`}
    >
      <ThemedText variant="bodyBold">{item.title}</ThemedText>
      <ThemedText variant="body" style={styles.announcementBody}>
        {item.body}
      </ThemedText>
      <View style={styles.announcementMeta}>
        <ThemedText variant="footnote" color="textTertiary">
          {displayName(item.author)}
        </ThemedText>
        <ThemedText variant="footnote" color="textTertiary">
          {formatRelativeTime(item.createdAt, t)}
        </ThemedText>
      </View>
      <View style={styles.replyCountRow}>
        <Ionicons name="chatbubble-outline" size={14} color={colors.textSecondary} />
        <ThemedText variant="footnote" color="textSecondary" style={styles.replyCountText}>
          {t('announcements.replyCount', { count: item._count?.replies ?? 0 })}
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
        <BackButton onPress={() => router.back()} style={styles.backButton} />
        <ThemedText variant="h2" style={styles.headerTitle}>
          Announcements
        </ThemedText>
        {canPost && (
          <TouchableOpacity
            onPress={() => setShowCompose(!showCompose)}
            style={styles.composeButton}
            hitSlop={HEADER_ICON_HIT_SLOP}
            accessibilityRole="button"
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
              testID="announcement-title-input"
            />
            {/* testID: an empty multiline input is absent from the iOS
                accessibility tree, so Maestro cannot find it by placeholder. */}
            <Input
              label="Message"
              placeholder="Write your announcement..."
              value={body}
              onChangeText={setBody}
              multiline
              numberOfLines={3}
              testID="announcement-body-input"
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
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              isFetchingNextPage ? <LoadingSpinner message="Loading more..." /> : null
            }
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
  replyCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  replyCountText: { marginLeft: spacing.xs },
});
