/**
 * Threaded replies under an announcement (#34).
 *
 * `useInfiniteAnnouncementReplies` pages the thread oldest-first, 20 at a
 * time, the way the server orders it. `useCreateReply` appends optimistically
 * so the composer feels instant on a slow connection, then reconciles with
 * the server's row; `useDeleteReply` removes optimistically. Both roll back
 * on error and invalidate the thread and the announcement (its reply count)
 * when settled. Real-time delivery is out of scope: the thread refetches
 * whenever the screen mounts or the user pulls to refresh.
 */

import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';
import { announcementKeys } from './useAnnouncements';

export interface AnnouncementReply {
  id: string;
  announcementId: string;
  authorId: string;
  body: string;
  createdAt: string;
  author: {
    id: string;
    name: string;
    profilePictureUrl?: string | null;
    /** Set when the author's account was deleted; render via `displayName`. */
    deletedAt?: string | null;
  };
}

export interface AnnouncementRepliesPage {
  success: boolean;
  replies: AnnouncementReply[];
  total: number;
  limit: number;
  offset: number;
}

export type AnnouncementRepliesData = InfiniteData<AnnouncementRepliesPage, number>;

export const replyKeys = {
  all: ['announcement-replies'] as const,
  thread: (announcementId: string) => [...replyKeys.all, announcementId] as const,
};

/** Default page size (matches the server default). */
export const REPLIES_PAGE_SIZE = 20;

/** Ids of optimistic rows start with this; the server never issues them. */
export const OPTIMISTIC_REPLY_PREFIX = 'optimistic-';

export function isOptimisticReply(reply: Pick<AnnouncementReply, 'id'>): boolean {
  return reply.id.startsWith(OPTIMISTIC_REPLY_PREFIX);
}

async function fetchRepliesPage(
  announcementId: string,
  limit: number,
  offset: number
): Promise<AnnouncementRepliesPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await apiClient.get<AnnouncementRepliesPage>(
    `/announcements/${announcementId}/replies?${params.toString()}`
  );
  return response.data;
}

export function useInfiniteAnnouncementReplies(announcementId: string, limit = REPLIES_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: replyKeys.thread(announcementId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchRepliesPage(announcementId, limit, pageParam),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, page) => n + page.replies.length, 0);
      return lastPage.replies.length < limit || loaded >= lastPage.total ? undefined : loaded;
    },
    select: (data) => ({
      replies: data.pages.flatMap((page) => page.replies),
      total: data.pages[0]?.total ?? 0,
    }),
    enabled: !!announcementId,
  });
}

export interface CreateReplyInput {
  teamId: string;
  announcementId: string;
  body: string;
  /** Who is sending, for the optimistic row. */
  author: AnnouncementReply['author'];
}

interface ReplyMutationContext {
  previous: AnnouncementRepliesData | undefined;
}

/** Append `reply` to the last loaded page (or open the first) and bump `total`. */
export function appendOptimisticReply(
  data: AnnouncementRepliesData | undefined,
  reply: AnnouncementReply
): AnnouncementRepliesData {
  if (!data || data.pages.length === 0) {
    return {
      pageParams: [0],
      pages: [{ success: true, replies: [reply], total: 1, limit: REPLIES_PAGE_SIZE, offset: 0 }],
    };
  }
  const pages = data.pages.map((page, index) => ({
    ...page,
    total: page.total + 1,
    replies: index === data.pages.length - 1 ? [...page.replies, reply] : page.replies,
  }));
  return { ...data, pages };
}

/** Drop the reply with `replyId` from every page and lower `total`. */
export function removeReplyFromPages(
  data: AnnouncementRepliesData | undefined,
  replyId: string
): AnnouncementRepliesData | undefined {
  if (!data) return data;
  let removed = false;
  const pages = data.pages.map((page) => {
    const replies = page.replies.filter((reply) => reply.id !== replyId);
    if (replies.length !== page.replies.length) removed = true;
    return { ...page, replies };
  });
  if (!removed) return data;
  return { ...data, pages: pages.map((page) => ({ ...page, total: Math.max(0, page.total - 1) })) };
}

export function useCreateReply() {
  const queryClient = useQueryClient();

  return useMutation<AnnouncementReply, Error, CreateReplyInput, ReplyMutationContext>({
    mutationFn: async ({ announcementId, body }) => {
      const response = await apiClient.post<{ success: boolean; reply: AnnouncementReply }>(
        `/announcements/${announcementId}/replies`,
        { body }
      );
      return response.data.reply;
    },
    onMutate: async ({ announcementId, body, author }) => {
      const key = replyKeys.thread(announcementId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AnnouncementRepliesData>(key);
      const optimistic: AnnouncementReply = {
        id: `${OPTIMISTIC_REPLY_PREFIX}${Date.now()}`,
        announcementId,
        authorId: author.id,
        body,
        createdAt: new Date().toISOString(),
        author,
      };
      queryClient.setQueryData<AnnouncementRepliesData>(key, (data) => appendOptimisticReply(data, optimistic));
      return { previous };
    },
    onError: (_error, { announcementId }, context) => {
      if (context) {
        queryClient.setQueryData(replyKeys.thread(announcementId), context.previous);
      }
    },
    onSuccess: (_reply, { teamId, announcementId }) => {
      trackEvent(AnalyticsEvents.ANNOUNCEMENT_REPLY_CREATED, { team_id: teamId, announcement_id: announcementId });
    },
    onSettled: (_reply, _error, { teamId, announcementId }) => {
      queryClient.invalidateQueries({ queryKey: replyKeys.thread(announcementId) });
      queryClient.invalidateQueries({ queryKey: announcementKeys.detail(announcementId) });
      queryClient.invalidateQueries({ queryKey: announcementKeys.team(teamId) });
    },
  });
}

export interface DeleteReplyInput {
  teamId: string;
  announcementId: string;
  replyId: string;
  /** Whether the caller wrote the reply (vs. a coach removing someone else's). */
  own: boolean;
}

export function useDeleteReply() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, DeleteReplyInput, ReplyMutationContext>({
    mutationFn: async ({ announcementId, replyId }) => {
      await apiClient.delete(`/announcements/${announcementId}/replies/${replyId}`);
    },
    onMutate: async ({ announcementId, replyId }) => {
      const key = replyKeys.thread(announcementId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AnnouncementRepliesData>(key);
      queryClient.setQueryData<AnnouncementRepliesData>(key, (data) => removeReplyFromPages(data, replyId));
      return { previous };
    },
    onError: (_error, { announcementId }, context) => {
      if (context) {
        queryClient.setQueryData(replyKeys.thread(announcementId), context.previous);
      }
    },
    onSuccess: (_void, { teamId, announcementId, own }) => {
      trackEvent(AnalyticsEvents.ANNOUNCEMENT_REPLY_DELETED, {
        team_id: teamId,
        announcement_id: announcementId,
        own,
      });
    },
    onSettled: (_void, _error, { teamId, announcementId }) => {
      queryClient.invalidateQueries({ queryKey: replyKeys.thread(announcementId) });
      queryClient.invalidateQueries({ queryKey: announcementKeys.detail(announcementId) });
      queryClient.invalidateQueries({ queryKey: announcementKeys.team(teamId) });
    },
  });
}
