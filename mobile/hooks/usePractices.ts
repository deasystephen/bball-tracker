/**
 * TanStack Query hooks for practice scheduling (#33): sessions, recurring
 * series and availability. API: docs/architecture/practice-scheduling.md.
 *
 * Every schedule mutation invalidates `practiceKeys.all` (lists, details,
 * availability, series); an availability answer only that practice's detail
 * and answers, since list rows carry none. The two that delete sessions (delete one, cancel a series) mark the
 * per-session queries (detail, availability) stale without refetching them:
 * the screen that did it is leaving, and a refetch would only fetch a 404.
 */

import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents, changedFields } from '../services/analytics';
import { practiceKeys } from './query-keys';
import type { RsvpStatus, RsvpSummary } from '../types/game';
import type {
  Practice,
  PracticeAvailability,
  PracticeDetailsInput,
  PracticeFilters,
  PracticeSeries,
  CreatePracticeInput,
  CreatePracticeSeriesInput,
  UpdatePracticeInput,
} from '../types/practice';

export { practiceKeys };

export interface PracticesPage {
  practices: Practice[];
  total: number;
  limit: number;
  offset: number;
}

function invalidateAll(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: practiceKeys.all });
}

/** Per-session queries: a deleted session answers 404 to both. */
const PER_SESSION = new Set(['detail', 'availability']);

/**
 * After a delete: lists and series refetch; per-session queries (detail and
 * availability) are only marked stale, so the mounted screen of a session
 * that no longer exists sends no request before it leaves. A session still
 * there refetches whenever its screen mounts next.
 */
function invalidateAfterDelete(queryClient: QueryClient): void {
  queryClient.invalidateQueries({
    queryKey: practiceKeys.all,
    predicate: (query) => PER_SESSION.has(String(query.queryKey[1])),
    refetchType: 'none',
  });
  queryClient.invalidateQueries({
    queryKey: practiceKeys.all,
    predicate: (query) => !PER_SESSION.has(String(query.queryKey[1])),
  });
}

/** One page of `GET /practices`, ascending by start. */
export function usePractices(filters: PracticeFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: practiceKeys.list(filters),
    queryFn: async (): Promise<PracticesPage> => {
      const params = new URLSearchParams();
      if (filters.teamId) params.append('teamId', filters.teamId);
      if (filters.status) params.append('status', filters.status);
      if (filters.from) params.append('from', filters.from);
      if (filters.to) params.append('to', filters.to);
      if (filters.limit) params.append('limit', String(filters.limit));
      if (filters.offset) params.append('offset', String(filters.offset));
      const response = await apiClient.get(`/practices?${params.toString()}`);
      const data = response.data as Partial<PracticesPage>;
      const practices = data.practices ?? [];
      return {
        practices,
        total: data.total ?? practices.length,
        limit: data.limit ?? filters.limit ?? practices.length,
        offset: data.offset ?? 0,
      };
    },
    enabled: options.enabled ?? true,
  });
}

/** `GET /practices/:id`, with `availabilitySummary`. */
export function usePractice(practiceId: string) {
  return useQuery({
    queryKey: practiceKeys.detail(practiceId),
    queryFn: async () => {
      const response = await apiClient.get(`/practices/${practiceId}`);
      return response.data.practice as Practice;
    },
    enabled: !!practiceId,
  });
}

/** `GET /practices/:id/availability`: the answers this caller may see, and the counts. */
export function usePracticeAvailability(practiceId: string) {
  return useQuery({
    queryKey: practiceKeys.availability(practiceId),
    queryFn: async () => {
      const response = await apiClient.get<{
        availability: PracticeAvailability[];
        summary: RsvpSummary;
      }>(`/practices/${practiceId}/availability`);
      return response.data;
    },
    enabled: !!practiceId,
  });
}

/** `GET /practice-series/:id` (the "edit all future" form starts from the series' own fields). */
export function usePracticeSeries(seriesId: string | null | undefined) {
  return useQuery({
    queryKey: practiceKeys.series(seriesId ?? ''),
    queryFn: async () => {
      const response = await apiClient.get(`/practice-series/${seriesId}`);
      return response.data.series as PracticeSeries;
    },
    enabled: !!seriesId,
  });
}

export function useCreatePractice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePracticeInput) => {
      const response = await apiClient.post('/practices', data);
      return response.data.practice as Practice;
    },
    onSuccess: (practice, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_CREATED, {
        practice_id: practice.id,
        team_id: variables.teamId,
        practice_type: practice.type,
      });
      invalidateAll(queryClient);
    },
  });
}

export function useCreatePracticeSeries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreatePracticeSeriesInput) => {
      const response = await apiClient.post('/practice-series', data);
      return response.data.series as PracticeSeries;
    },
    onSuccess: (series, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_SERIES_CREATED, {
        series_id: series.id,
        team_id: variables.teamId,
        practice_type: series.type,
        frequency: variables.frequency,
        weekday_count: variables.weekdays.length,
        session_count: series.sessions?.length ?? 0,
        ends: variables.endDate !== undefined ? 'date' : 'count',
      });
      invalidateAll(queryClient);
    },
  });
}

/** "Edit this practice": one session; on a series occurrence it becomes an exception. */
export function useUpdatePractice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ practiceId, data }: { practiceId: string; data: UpdatePracticeInput }) => {
      const response = await apiClient.patch(`/practices/${practiceId}`, data);
      return response.data.practice as Practice;
    },
    onSuccess: (practice, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_UPDATED, {
        practice_id: variables.practiceId,
        in_series: practice.seriesId !== null,
        fields: changedFields(variables.data),
      });
      invalidateAll(queryClient);
    },
  });
}

/** "Edit all future practices": the descriptive fields on the series and its upcoming sessions. */
export function useUpdatePracticeSeries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ seriesId, data }: { seriesId: string; data: PracticeDetailsInput }) => {
      const response = await apiClient.patch(`/practice-series/${seriesId}`, data);
      return response.data as { series: PracticeSeries; updatedSessions: number };
    },
    onSuccess: (result, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_SERIES_UPDATED, {
        series_id: variables.seriesId,
        fields: changedFields(variables.data),
        updated_sessions: result.updatedSessions ?? 0,
      });
      invalidateAll(queryClient);
    },
  });
}

/** Cancel one session: it stays, marked cancelled, with its answers. */
export function useCancelPractice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ practiceId, reason }: { practiceId: string; reason?: string }) => {
      const response = await apiClient.post(
        `/practices/${practiceId}/cancel`,
        reason ? { reason } : {}
      );
      return response.data.practice as Practice;
    },
    onSuccess: (practice, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_CANCELLED, {
        practice_id: variables.practiceId,
        in_series: practice.seriesId !== null,
        has_reason: !!variables.reason,
      });
      invalidateAll(queryClient);
    },
  });
}

/** Cancel a series: the server deletes every session that has not started; past ones stay. */
export function useCancelPracticeSeries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (seriesId: string) => {
      const response = await apiClient.delete(`/practice-series/${seriesId}`);
      return response.data as { series: PracticeSeries; deletedSessions: number };
    },
    onSuccess: (result, seriesId) => {
      trackEvent(AnalyticsEvents.PRACTICE_SERIES_CANCELLED, {
        series_id: seriesId,
        deleted_sessions: result.deletedSessions ?? 0,
      });
      invalidateAfterDelete(queryClient);
    },
  });
}

export function useDeletePractice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ practiceId }: { practiceId: string; inSeries: boolean }) => {
      await apiClient.delete(`/practices/${practiceId}`);
    },
    onSuccess: (_data, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_DELETED, {
        practice_id: variables.practiceId,
        in_series: variables.inSeries,
      });
      invalidateAfterDelete(queryClient);
    },
  });
}

/**
 * Answer availability. A rostered player answers for themself; a guardian
 * passes `playerId` to answer for a rostered child (the row is the child's).
 * `comment` left out keeps the stored one; an empty string clears it.
 */
export function useSubmitPracticeAvailability() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      practiceId,
      status,
      playerId,
      comment,
    }: {
      practiceId: string;
      status: RsvpStatus;
      playerId?: string;
      comment?: string;
    }) => {
      const body: { status: RsvpStatus; playerId?: string; comment?: string } = { status };
      if (playerId) body.playerId = playerId;
      if (comment !== undefined) body.comment = comment;
      const response = await apiClient.put(`/practices/${practiceId}/availability`, body);
      return response.data.availability as PracticeAvailability;
    },
    onSuccess: (_row, variables) => {
      trackEvent(AnalyticsEvents.PRACTICE_AVAILABILITY_SUBMITTED, {
        practice_id: variables.practiceId,
        status: variables.status,
        on_behalf_of_child: !!variables.playerId,
        has_comment: !!variables.comment,
      });
      // An answer changes this practice's counts and rows only; list rows carry no answers.
      queryClient.invalidateQueries({ queryKey: practiceKeys.detail(variables.practiceId) });
      queryClient.invalidateQueries({ queryKey: practiceKeys.availability(variables.practiceId) });
    },
  });
}
