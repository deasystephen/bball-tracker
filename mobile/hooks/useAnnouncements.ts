/**
 * React Query hooks for Announcements API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

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
}

export const announcementKeys = {
  all: ['announcements'] as const,
  team: (teamId: string) => [...announcementKeys.all, teamId] as const,
};

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
      queryClient.invalidateQueries({ queryKey: announcementKeys.team(variables.teamId) });
    },
  });
}
