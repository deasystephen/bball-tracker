/**
 * Runtime tests for hooks/usePractices.ts (#33): request shapes, response
 * unwrapping, the analytics event of each mutation, and invalidation (every
 * mutation refreshes lists, details and availability; a delete or a series
 * cancel only marks details stale, so the screen that did it never refetches
 * a 404).
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  usePractices,
  usePractice,
  usePracticeAvailability,
  useSubmitPracticeAvailability,
  useCancelPractice,
  useCancelPracticeSeries,
  useDeletePractice,
  useCreatePracticeSeries,
  useUpdatePracticeSeries,
  practiceKeys,
} from '../../hooks/usePractices';
import { apiClient } from '../../services/api-client';
import { trackEvent, AnalyticsEvents } from '../../services/analytics';
import { createQueryWrapper } from '../utils/queryWrapper';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedTrack = trackEvent as jest.Mock;
const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPut = apiClient.put as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;
const mockedDelete = apiClient.delete as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

it('lists practices with the filters it was given', async () => {
  mockedGet.mockResolvedValue({ data: { practices: [{ id: 'p1' }], total: 3, limit: 1, offset: 0 } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(
    () => usePractices({ teamId: 't1', from: '2026-12-01T05:00:00.000Z', limit: 200 }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mockedGet).toHaveBeenCalledWith('/practices?teamId=t1&from=2026-12-01T05%3A00%3A00.000Z&limit=200');
  expect(result.current.data).toEqual({ practices: [{ id: 'p1' }], total: 3, limit: 1, offset: 0 });
});

it('answers for a child with playerId, leaves a missing comment out, and refreshes the practice', async () => {
  mockedPut.mockResolvedValue({ data: { availability: { id: 'a1' } } });
  const { wrapper, client } = createQueryWrapper();
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(() => useSubmitPracticeAvailability(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ practiceId: 'p1', status: 'MAYBE', playerId: 'steph' });
  });
  expect(mockedPut).toHaveBeenCalledWith('/practices/p1/availability', { status: 'MAYBE', playerId: 'steph' });
  expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.PRACTICE_AVAILABILITY_SUBMITTED, {
    practice_id: 'p1',
    status: 'MAYBE',
    on_behalf_of_child: true,
    has_comment: false,
  });
  // Only this practice's detail and answers: list rows carry no availability.
  expect(invalidate).toHaveBeenCalledWith({ queryKey: practiceKeys.detail('p1') });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: practiceKeys.availability('p1') });
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: practiceKeys.all });
});

it('sends an empty comment to clear it', async () => {
  mockedPut.mockResolvedValue({ data: { availability: { id: 'a1' } } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(() => useSubmitPracticeAvailability(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ practiceId: 'p1', status: 'YES', comment: '' });
  });
  expect(mockedPut).toHaveBeenCalledWith('/practices/p1/availability', { status: 'YES', comment: '' });
});

it('cancels one practice with its reason', async () => {
  mockedPost.mockResolvedValue({ data: { practice: { id: 'p1', seriesId: 's1' } } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(() => useCancelPractice(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ practiceId: 'p1', reason: 'Gym closed' });
  });
  expect(mockedPost).toHaveBeenCalledWith('/practices/p1/cancel', { reason: 'Gym closed' });
  expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.PRACTICE_CANCELLED, {
    practice_id: 'p1',
    in_series: true,
    has_reason: true,
  });
});

it('a series cancel refreshes the lists but does not refetch the open practice it deleted', async () => {
  mockedDelete.mockResolvedValue({ data: { series: { id: 's1' }, deletedSessions: 6 } });
  mockedGet.mockImplementation(async (url: string) =>
    url === '/practices/p1'
      ? { data: { practice: { id: 'p1' } } }
      : url === '/practices/p1/availability'
        ? { data: { availability: [], summary: { yes: 0, no: 0, maybe: 0 } } }
        : { data: { practices: [], total: 0, limit: 50, offset: 0 } }
  );
  const { wrapper, client } = createQueryWrapper();
  // The open practice detail and the schedule list, both observed.
  renderHook(
    () => {
      usePractice('p1');
      usePracticeAvailability('p1');
      usePractices({ teamId: 't1' });
    },
    { wrapper }
  );
  await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(3));
  const callsTo = (url: string) => mockedGet.mock.calls.filter(([called]) => called === url).length;

  const { result } = renderHook(() => useCancelPracticeSeries(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync('s1');
  });

  expect(mockedDelete).toHaveBeenCalledWith('/practice-series/s1');
  expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.PRACTICE_SERIES_CANCELLED, {
    series_id: 's1',
    deleted_sessions: 6,
  });
  await waitFor(() => expect(callsTo('/practices?teamId=t1')).toBe(2));
  expect(callsTo('/practices/p1')).toBe(1);
  expect(callsTo('/practices/p1/availability')).toBe(1);
  expect(client.getQueryState(practiceKeys.detail('p1'))?.isInvalidated).toBe(true);
});

it('deletes one practice', async () => {
  mockedDelete.mockResolvedValue({ data: { success: true } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(() => useDeletePractice(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ practiceId: 'p1', inSeries: false });
  });
  expect(mockedDelete).toHaveBeenCalledWith('/practices/p1');
  expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.PRACTICE_DELETED, { practice_id: 'p1', in_series: false });
});

it('creates a series and reports how many sessions the server made', async () => {
  mockedPost.mockResolvedValue({ data: { series: { id: 's1', type: 'PRACTICE', sessions: [{}, {}] } } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(() => useCreatePracticeSeries(), { wrapper });
  const body = {
    teamId: 't1',
    frequency: 'BIWEEKLY' as const,
    weekdays: [2, 4],
    startDate: '2026-12-01',
    startTime: '18:00',
    durationMinutes: 90,
    timezone: 'America/New_York',
    endDate: '2027-02-01',
  };
  await act(async () => {
    await result.current.mutateAsync(body);
  });
  expect(mockedPost).toHaveBeenCalledWith('/practice-series', body);
  expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.PRACTICE_SERIES_CREATED, {
    series_id: 's1',
    team_id: 't1',
    practice_type: 'PRACTICE',
    frequency: 'BIWEEKLY',
    weekday_count: 2,
    session_count: 2,
    ends: 'date',
  });
});

it('edits all future practices and reports the count, never the values', async () => {
  mockedPatch.mockResolvedValue({ data: { series: { id: 's1' }, updatedSessions: 5 } });
  const { wrapper } = createQueryWrapper();
  const { result } = renderHook(() => useUpdatePracticeSeries(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ seriesId: 's1', data: { location: 'Gym B', notes: '' } });
  });
  expect(mockedPatch).toHaveBeenCalledWith('/practice-series/s1', { location: 'Gym B', notes: '' });
  expect(mockedTrack).toHaveBeenCalledWith(AnalyticsEvents.PRACTICE_SERIES_UPDATED, {
    series_id: 's1',
    fields: 'location,notes',
    updated_sessions: 5,
  });
});
