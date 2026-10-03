/**
 * React Query hooks for Announcements API
 */

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';

export interface Announcement {
  id: string;
  teamId: string;
  authorId: string;
  title: string;
  body: string;
  createdAt: string;
  author: {
    id: string;
    name: string;
    email?: string;
  };
  /** Reply count (#34); absent from responses older than the thread feature. */
  _count?: { replies: number };
}

export const announcementKeys = {
  all: ['announcements'] as const,
  team: (teamId: string) => [...announcementKeys.all, teamId] as const,
  // Nested under `team()` so the create-mutation invalidation covers it.
  teamInfinite: (teamId: string) => [...announcementKeys.team(teamId), 'infinite'] as const,
  /** One announcement by id (the thread screen, a push deep link). */
  detail: (announcementId: string) => [...announcementKeys.all, 'detail', announcementId] as const,
};

/** Default page size for announcements (matches the server default). */
export const ANNOUNCEMENTS_PAGE_SIZE = 20;

export interface AnnouncementsPage {
  success: boolean;
  announcements: Announcement[];
  total: number;
}

async function fetchAnnouncementsPage(
  teamId: string,
  limit: number,
  offset: number
): Promise<AnnouncementsPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await apiClient.get<AnnouncementsPage>(
    `/teams/${teamId}/announcements?${params.toString()}`
  );
  return response.data;
}

/**
 * Infinite (paginated) announcements for a team. Feed `fetchNextPage` to
 * `FlatList.onEndReached`.
 */
export function useInfiniteAnnouncements(teamId: string, limit = ANNOUNCEMENTS_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: announcementKeys.teamInfinite(teamId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchAnnouncementsPage(teamId, limit, pageParam),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, page) => n + page.announcements.length, 0);
      return lastPage.announcements.length < limit || loaded >= lastPage.total
        ? undefined
        : loaded;
    },
    select: (data) => ({
      announcements: data.pages.flatMap((page) => page.announcements),
      total: data.pages[0]?.total ?? 0,
    }),
    enabled: !!teamId,
  });
}

/**
 * Hook to fetch announcements for a team
 */
export function useAnnouncements(teamId: string) {
  return useQuery({
    queryKey: announcementKeys.team(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{
        success: boolean;
        announcements: Announcement[];
        total: number;
      }>(`/teams/${teamId}/announcements`);
      return response.data;
    },
    enabled: !!teamId,
  });
}

/**
 * One announcement (GET /announcements/:id): the thread screen's header, and
 * what a push deep link loads when the team's list was never fetched.
 */
export function useAnnouncement(announcementId: string) {
  return useQuery({
    queryKey: announcementKeys.detail(announcementId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; announcement: Announcement }>(
        `/announcements/${announcementId}`
      );
      return response.data.announcement;
    },
    enabled: !!announcementId,
  });
}

/**
 * Hook to create an announcement
 */
export function useCreateAnnouncement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: { title: string; body: string } }) => {
      const response = await apiClient.post<{ success: boolean; announcement: Announcement }>(
        `/teams/${teamId}/announcements`,
        data
      );
      return response.data.announcement;
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.ANNOUNCEMENT_CREATED, { team_id: variables.teamId });
      queryClient.invalidateQueries({ queryKey: announcementKeys.team(variables.teamId) });
    },
  });
}
