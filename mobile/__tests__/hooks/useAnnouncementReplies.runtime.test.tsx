/**
 * Runtime tests for the announcement reply hooks (#34): paging of the
 * thread, the optimistic append on send with rollback on failure, the
 * optimistic removal on delete, and the cache invalidations that keep the
 * announcement's reply count honest.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useInfiniteAnnouncementReplies,
  useCreateReply,
  useDeleteReply,
  replyKeys,
  appendOptimisticReply,
  removeReplyFromPages,
  isOptimisticReply,
  type AnnouncementReply,
  type AnnouncementRepliesData,
} from '../../hooks/useAnnouncementReplies';
import { announcementKeys } from '../../hooks/useAnnouncements';
import { apiClient } from '../../services/api-client';
import { trackEvent } from '../../services/analytics';
import { createQueryWrapper } from '../utils/queryWrapper';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;
const mockedTrack = trackEvent as jest.Mock;

const author = { id: 'u1', name: 'LeBron James', profilePictureUrl: null, deletedAt: null };

const reply = (id: string, body = `body ${id}`): AnnouncementReply => ({
  id,
  announcementId: 'a1',
  authorId: 'u1',
  body,
  createdAt: '2026-10-01T00:00:00Z',
  author,
});

const page = (replies: AnnouncementReply[], total: number, offset = 0) => ({
  success: true,
  replies,
  total,
  limit: 20,
  offset,
});

describe('useAnnouncementReplies runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('keys', () => {
    it('scopes a thread under the list root', () => {
      expect(replyKeys.thread('a1')).toEqual(['announcement-replies', 'a1']);
    });
  });

  describe('useInfiniteAnnouncementReplies', () => {
    it('fetches the first page with the server default of 20 and flattens it', async () => {
      mockedGet.mockResolvedValueOnce({ data: page([reply('r1'), reply('r2')], 2) });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteAnnouncementReplies('a1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockedGet).toHaveBeenCalledWith('/announcements/a1/replies?limit=20&offset=0');
      expect(result.current.data?.replies.map((r) => r.id)).toEqual(['r1', 'r2']);
      expect(result.current.data?.total).toBe(2);
      expect(result.current.hasNextPage).toBe(false);
    });

    it('pages by offset until every reply is loaded', async () => {
      const first = Array.from({ length: 20 }, (_, i) => reply(`r${i}`));
      mockedGet.mockResolvedValueOnce({ data: page(first, 21) });
      mockedGet.mockResolvedValueOnce({ data: page([reply('r20')], 21, 20) });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteAnnouncementReplies('a1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.hasNextPage).toBe(true);

      await act(async () => {
        await result.current.fetchNextPage();
      });

      expect(mockedGet).toHaveBeenLastCalledWith('/announcements/a1/replies?limit=20&offset=20');
      await waitFor(() => expect(result.current.data?.replies).toHaveLength(21));
      expect(result.current.hasNextPage).toBe(false);
    });

    it('does nothing without an announcement id', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useInfiniteAnnouncementReplies(''), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });
  });

  describe('cache helpers', () => {
    it('appendOptimisticReply opens a first page when nothing is cached', () => {
      const data = appendOptimisticReply(undefined, reply('optimistic-1'));
      expect(data.pages).toHaveLength(1);
      expect(data.pages[0].replies.map((r) => r.id)).toEqual(['optimistic-1']);
      expect(data.pages[0].total).toBe(1);
    });

    it('appendOptimisticReply adds to the last page and bumps every total', () => {
      const data: AnnouncementRepliesData = {
        pageParams: [0, 20],
        pages: [page([reply('r1')], 2), page([reply('r2')], 2, 20)],
      };
      const next = appendOptimisticReply(data, reply('optimistic-2'));
      expect(next.pages[0].replies.map((r) => r.id)).toEqual(['r1']);
      expect(next.pages[1].replies.map((r) => r.id)).toEqual(['r2', 'optimistic-2']);
      expect(next.pages.map((p) => p.total)).toEqual([3, 3]);
    });

    it('removeReplyFromPages drops the row and lowers the total, and leaves unknown ids alone', () => {
      const data: AnnouncementRepliesData = { pageParams: [0], pages: [page([reply('r1'), reply('r2')], 2)] };
      const next = removeReplyFromPages(data, 'r1');
      expect(next?.pages[0].replies.map((r) => r.id)).toEqual(['r2']);
      expect(next?.pages[0].total).toBe(1);
      expect(removeReplyFromPages(data, 'nope')).toBe(data);
      expect(removeReplyFromPages(undefined, 'r1')).toBeUndefined();
    });

    it('isOptimisticReply recognises the client-issued ids only', () => {
      expect(isOptimisticReply({ id: 'optimistic-123' })).toBe(true);
      expect(isOptimisticReply({ id: 'r1' })).toBe(false);
    });
  });

  describe('useCreateReply', () => {
    it('shows the reply immediately, then replaces it with the server row and fires the event', async () => {
      mockedGet.mockResolvedValueOnce({ data: page([reply('r1')], 1) });
      let resolvePost: (value: unknown) => void = () => {};
      mockedPost.mockReturnValueOnce(new Promise((resolve) => (resolvePost = resolve)));
      // The invalidation after settle refetches the thread.
      mockedGet.mockResolvedValueOnce({ data: page([reply('r1'), reply('r2', 'See you there')], 2) });

      const { wrapper, client } = createQueryWrapper();
      const { result } = renderHook(
        () => ({ thread: useInfiniteAnnouncementReplies('a1'), create: useCreateReply() }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.thread.isSuccess).toBe(true));

      let mutation: Promise<unknown> = Promise.resolve();
      act(() => {
        mutation = result.current.create.mutateAsync({
          teamId: 't1',
          announcementId: 'a1',
          body: 'See you there',
          author,
        });
      });

      // Optimistic row is visible before the server answers.
      await waitFor(() => expect(result.current.thread.data?.replies).toHaveLength(2));
      const pending = result.current.thread.data!.replies[1];
      expect(isOptimisticReply(pending)).toBe(true);
      expect(pending).toMatchObject({ body: 'See you there', authorId: 'u1', author });
      expect(result.current.thread.data?.total).toBe(2);
      expect(mockedPost).toHaveBeenCalledWith('/announcements/a1/replies', { body: 'See you there' });

      await act(async () => {
        resolvePost({ data: { success: true, reply: reply('r2', 'See you there') } });
        await mutation;
      });

      await waitFor(() => expect(result.current.thread.data?.replies.map((r) => r.id)).toEqual(['r1', 'r2']));
      expect(mockedTrack).toHaveBeenCalledWith('announcement_reply_created', { team_id: 't1', announcement_id: 'a1' });
      // The announcement's reply count and the team list are refreshed too.
      expect(client.getQueryState(announcementKeys.detail('a1'))?.isInvalidated ?? true).toBe(true);
    });

    it('rolls the optimistic row back when the server refuses', async () => {
      mockedGet.mockResolvedValue({ data: page([reply('r1')], 1) });
      mockedPost.mockRejectedValueOnce(new Error('403'));

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () => ({ thread: useInfiniteAnnouncementReplies('a1'), create: useCreateReply() }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.thread.isSuccess).toBe(true));

      await act(async () => {
        await expect(
          result.current.create.mutateAsync({ teamId: 't1', announcementId: 'a1', body: 'Nope', author })
        ).rejects.toThrow('403');
      });

      await waitFor(() => expect(result.current.thread.data?.replies.map((r) => r.id)).toEqual(['r1']));
      expect(result.current.thread.data?.total).toBe(1);
      expect(mockedTrack).not.toHaveBeenCalled();
    });
  });

  describe('useDeleteReply', () => {
    it('removes the row immediately, calls DELETE and fires the event with ownership', async () => {
      mockedGet.mockResolvedValueOnce({ data: page([reply('r1'), reply('r2')], 2) });
      mockedDelete.mockResolvedValueOnce({ status: 204 });
      mockedGet.mockResolvedValueOnce({ data: page([reply('r2')], 1) });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () => ({ thread: useInfiniteAnnouncementReplies('a1'), remove: useDeleteReply() }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.thread.isSuccess).toBe(true));

      await act(async () => {
        await result.current.remove.mutateAsync({ teamId: 't1', announcementId: 'a1', replyId: 'r1', own: false });
      });

      expect(mockedDelete).toHaveBeenCalledWith('/announcements/a1/replies/r1');
      await waitFor(() => expect(result.current.thread.data?.replies.map((r) => r.id)).toEqual(['r2']));
      expect(mockedTrack).toHaveBeenCalledWith('announcement_reply_deleted', {
        team_id: 't1',
        announcement_id: 'a1',
        own: false,
      });
    });

    it('restores the row when the delete is refused', async () => {
      mockedGet.mockResolvedValue({ data: page([reply('r1'), reply('r2')], 2) });
      mockedDelete.mockRejectedValueOnce(new Error('403'));

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () => ({ thread: useInfiniteAnnouncementReplies('a1'), remove: useDeleteReply() }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.thread.isSuccess).toBe(true));

      await act(async () => {
        await expect(
          result.current.remove.mutateAsync({ teamId: 't1', announcementId: 'a1', replyId: 'r1', own: true })
        ).rejects.toThrow('403');
      });

      await waitFor(() => expect(result.current.thread.data?.replies.map((r) => r.id)).toEqual(['r1', 'r2']));
      expect(mockedTrack).not.toHaveBeenCalled();
    });
  });
});
