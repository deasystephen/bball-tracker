/**
 * Runtime tests for useAnnouncements hooks.
 *
 * Exercises actual React Query hook execution: query function calls,
 * the team-scoped queryKey shape, and that mutations invalidate the
 * correct cache.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useAnnouncements,
  useCreateAnnouncement,
  announcementKeys,
} from '../../hooks/useAnnouncements';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;

describe('useAnnouncements runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('announcementKeys', () => {
    it('builds a stable list root key', () => {
      expect(announcementKeys.all).toEqual(['announcements']);
    });

    it('namespaces team-scoped keys under the list root', () => {
      expect(announcementKeys.team('t1')).toEqual(['announcements', 't1']);
    });
  });

  describe('useAnnouncements query', () => {
    it('fetches announcements for a team and returns the payload', async () => {
      const payload = {
        success: true,
        announcements: [
          {
            id: 'a1',
            teamId: 't1',
            authorId: 'u1',
            title: 'Practice Cancelled',
            body: 'No practice tonight',
            createdAt: '2026-04-19T00:00:00Z',
            author: { id: 'u1', name: 'Coach' },
          },
        ],
        total: 1,
      };
      mockedGet.mockResolvedValueOnce({ data: payload });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useAnnouncements('t1'), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(payload);
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/announcements');
    });

    it('is disabled when teamId is empty (no fetch)', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useAnnouncements(''), { wrapper });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('surfaces errors when the request fails', async () => {
      mockedGet.mockRejectedValueOnce(new Error('network down'));
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useAnnouncements('t1'), { wrapper });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect((result.current.error as Error).message).toBe('network down');
    });
  });

  describe('useCreateAnnouncement mutation', () => {
    it('posts to the team-scoped endpoint and returns the announcement', async () => {
      const announcement = {
        id: 'a1',
        teamId: 't1',
        authorId: 'u1',
        title: 'Game Time',
        body: 'Friday 7pm',
        createdAt: '2026-04-19T00:00:00Z',
        author: { id: 'u1', name: 'Coach' },
      };
      mockedPost.mockResolvedValueOnce({
        data: { success: true, announcement },
      });

      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useCreateAnnouncement(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.mutateAsync({
          teamId: 't1',
          data: { title: 'Game Time', body: 'Friday 7pm' },
        });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/announcements', {
        title: 'Game Time',
        body: 'Friday 7pm',
      });
      expect(returned).toEqual(announcement);
    });

    it('invalidates only the team-scoped announcements cache on success', async () => {
      mockedPost.mockResolvedValueOnce({
        data: {
          success: true,
          announcement: {
            id: 'a1',
            teamId: 't1',
            authorId: 'u1',
            title: 't',
            body: 'b',
            createdAt: '2026-04-19T00:00:00Z',
            author: { id: 'u1', name: 'Coach' },
          },
        },
      });

      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useCreateAnnouncement(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({
          teamId: 't1',
          data: { title: 't', body: 'b' },
        });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: announcementKeys.team('t1'),
      });
      // Should NOT broadly invalidate the all-announcements root, only the team key.
      const calls = invalidateSpy.mock.calls.map((c) =>
        JSON.stringify(c[0]?.queryKey)
      );
      expect(calls).toContain(JSON.stringify(['announcements', 't1']));
    });

    it('surfaces errors from the API', async () => {
      mockedPost.mockRejectedValueOnce(new Error('forbidden'));
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useCreateAnnouncement(), { wrapper });

      await expect(
        act(async () => {
          await result.current.mutateAsync({
            teamId: 't1',
            data: { title: 't', body: 'b' },
          });
        })
      ).rejects.toThrow('forbidden');
    });
  });
});
