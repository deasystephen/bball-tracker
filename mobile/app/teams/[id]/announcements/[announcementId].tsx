/**
 * Announcement thread — the announcement with its replies and an inline
 * composer (#34). One level deep: replies belong to the announcement, never
 * to another reply.
 *
 * Anyone with access to the team may reply (the server gates on
 * `canAccessTeam`, guardians included). A reply's ⋯ menu offers Delete to its
 * author and to anyone with `canManageTeam` (coaches); the API stays the
 * authority (403). Sends are optimistic. Real-time delivery is out of scope:
 * the thread refetches on mount and on pull-to-refresh.
 */

import React, { useState } from 'react';
import { View, StyleSheet, FlatList, TouchableOpacity, KeyboardAvoidingView, Platform, RefreshControl } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  ThemedView,
  ThemedText,
  Card,
  Input,
  LoadingSpinner,
  ErrorState,
  EmptyState,
  ActionMenu,
  type ActionMenuItem,
} from '../../../../components';
import { useToast } from '../../../../components/Toast';
import { useTeam, hasTeamPermission } from '../../../../hooks/useTeams';
import { useAnnouncement } from '../../../../hooks/useAnnouncements';
import {
  useInfiniteAnnouncementReplies,
  useCreateReply,
  useDeleteReply,
  isOptimisticReply,
  type AnnouncementReply,
} from '../../../../hooks/useAnnouncementReplies';
import { useTheme } from '../../../../hooks/useTheme';
import { useTranslation } from '../../../../i18n';
import { spacing, borderRadius } from '../../../../theme';
import { getHorizontalPadding } from '../../../../utils/responsive';
import { useAuthUser } from '../../../../store/auth-store';
import { getApiErrorMessage } from '../../../../services/api-client';
import { displayName } from '../../../../utils/display-name';
import { useGoBack } from '../../../../hooks/useGoBack';
import { formatRelativeTime } from '../../../../utils/relative-time';
import { HEADER_ICON_HIT_SLOP } from '../../../../utils/touch-target';

export default function AnnouncementThreadScreen() {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/teams');
  const { id, announcementId } = useLocalSearchParams<{ id: string; announcementId: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const user = useAuthUser();

  const { data: team } = useTeam(id);
  const {
    data: announcement,
    isLoading: announcementLoading,
    error: announcementError,
    refetch: refetchAnnouncement,
  } = useAnnouncement(announcementId);
  const {
    data: thread,
    isLoading: repliesLoading,
    error: repliesError,
    refetch: refetchReplies,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isRefetching,
  } = useInfiniteAnnouncementReplies(announcementId);
  const createReply = useCreateReply();
  const deleteReply = useDeleteReply();

  const [body, setBody] = useState('');
  const [menuReplyId, setMenuReplyId] = useState<string | null>(null);

  const canManage = hasTeamPermission(team, user?.id, 'canManageTeam', user?.role, user?.leagueAdminOf);
  const canDelete = (reply: AnnouncementReply): boolean =>
    !isOptimisticReply(reply) && (reply.authorId === user?.id || canManage);

  const handleSend = async () => {
    const trimmed = body.trim();
    if (!trimmed || !user || createReply.isPending) return;
    setBody('');
    try {
      await createReply.mutateAsync({
        teamId: id,
        announcementId,
        body: trimmed,
        author: { id: user.id, name: user.name, profilePictureUrl: user.profilePictureUrl ?? null, deletedAt: null },
      });
    } catch (err) {
      // The optimistic row was rolled back; hand the text back for a retry.
      setBody(trimmed);
      toast.showToast(getApiErrorMessage(err, t('announcements.replyFailed')), 'error');
    }
  };

  const handleDelete = async (reply: AnnouncementReply) => {
    setMenuReplyId(null);
    try {
      await deleteReply.mutateAsync({
        teamId: id,
        announcementId,
        replyId: reply.id,
        own: reply.authorId === user?.id,
      });
      toast.showToast(t('announcements.replyDeleted'), 'success');
    } catch (err) {
      toast.showToast(getApiErrorMessage(err, t('announcements.deleteFailed')), 'error');
    }
  };

  const menuItemsFor = (reply: AnnouncementReply): ActionMenuItem[] => [
    { label: t('announcements.deleteReply'), destructive: true, onPress: () => handleDelete(reply) },
  ];

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };

  if (announcementLoading || repliesLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  const error = announcementError ?? repliesError;
  if (error || !announcement || !thread) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : t('announcements.loadError')}
        onRetry={() => {
          refetchAnnouncement();
          refetchReplies();
        }}
        onBack={goBack}
      />
    );
  }

  const menuReply = menuReplyId ? thread.replies.find((reply) => reply.id === menuReplyId) : undefined;

  const renderReply = ({ item }: { item: AnnouncementReply }) => {
    const pending = isOptimisticReply(item);
    return (
      <View style={[styles.replyRow, pending && styles.replyPending]} testID={`reply-${item.id}`}>
        <View style={styles.replyContent}>
          <View style={styles.replyMeta}>
            <ThemedText variant="captionBold">{displayName(item.author)}</ThemedText>
            <ThemedText variant="footnote" color="textTertiary">
              {pending ? t('announcements.sending') : formatRelativeTime(item.createdAt, t)}
            </ThemedText>
          </View>
          <ThemedText variant="body">{item.body}</ThemedText>
        </View>
        {canDelete(item) && (
          <TouchableOpacity
            onPress={() => setMenuReplyId(item.id)}
            style={styles.menuButton}
            accessibilityRole="button"
            accessibilityLabel={t('announcements.replyMenu')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const listHeader = (
    <View>
      <Card variant="elevated" style={styles.announcementCard}>
        <ThemedText variant="h3">{announcement.title}</ThemedText>
        <ThemedText variant="body" style={styles.announcementBody}>
          {announcement.body}
        </ThemedText>
        <View style={styles.announcementMeta}>
          <ThemedText variant="footnote" color="textTertiary">
            {displayName(announcement.author)}
          </ThemedText>
          <ThemedText variant="footnote" color="textTertiary">
            {formatRelativeTime(announcement.createdAt, t)}
          </ThemedText>
        </View>
      </Card>
      <ThemedText variant="captionBold" color="textSecondary" style={styles.repliesHeading}>
        {t('announcements.replyCount', { count: thread.total })}
      </ThemedText>
    </View>
  );

  return (
    <ThemedView variant="background" style={styles.container}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + spacing.md, paddingHorizontal: padding, borderBottomColor: colors.border },
        ]}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={HEADER_ICON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <ThemedText variant="h2">{t('announcements.title')}</ThemedText>
          {team && (
            <ThemedText variant="caption" color="textSecondary">
              {team.name}
            </ThemedText>
          )}
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
        keyboardVerticalOffset={insets.top}
      >
        <FlatList
          data={thread.replies}
          keyExtractor={(item) => item.id}
          renderItem={renderReply}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            <EmptyState
              icon="chatbubble-ellipses-outline"
              title={t('announcements.noReplies')}
              message={t('announcements.noRepliesMessage')}
            />
          }
          ListFooterComponent={isFetchingNextPage ? <LoadingSpinner message={t('announcements.loadingMore')} /> : null}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching && !isFetchingNextPage}
              onRefresh={() => {
                refetchAnnouncement();
                refetchReplies();
              }}
            />
          }
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: padding, paddingTop: spacing.md, paddingBottom: spacing.xl }}
        />

        <View
          style={[
            styles.composer,
            {
              paddingHorizontal: padding,
              paddingBottom: insets.bottom + spacing.sm,
              borderTopColor: colors.border,
              backgroundColor: colors.background,
            },
          ]}
        >
          <View style={styles.composerInput}>
            <Input
              placeholder={t('announcements.replyPlaceholder')}
              value={body}
              onChangeText={setBody}
              multiline
              maxLength={2000}
              testID="reply-input"
              accessibilityLabel={t('announcements.replyPlaceholder')}
            />
          </View>
          <TouchableOpacity
            onPress={handleSend}
            disabled={!body.trim() || createReply.isPending}
            style={[
              styles.sendButton,
              { backgroundColor: body.trim() && !createReply.isPending ? colors.primary : colors.border },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('announcements.send')}
            accessibilityState={{ disabled: !body.trim() || createReply.isPending }}
            testID="reply-send"
          >
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <ActionMenu
        visible={menuReply !== undefined}
        title={menuReply ? displayName(menuReply.author) : ''}
        items={menuReply ? menuItemsFor(menuReply) : []}
        onClose={() => setMenuReplyId(null)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    padding: spacing.sm,
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  headerContent: { flex: 1 },
  announcementCard: { marginBottom: spacing.md },
  announcementBody: { marginTop: spacing.xs },
  announcementMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  repliesHeading: { marginBottom: spacing.sm },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
  },
  replyPending: { opacity: 0.6 },
  replyContent: { flex: 1 },
  replyMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  menuButton: {
    padding: spacing.xs,
    marginLeft: spacing.sm,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  composerInput: { flex: 1 },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
});
