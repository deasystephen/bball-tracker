/**
 * Runtime tests for hooks/useJoinLink.ts (team join links, #210).
 *
 * Exercises the React Query hooks against the mocked api-client: endpoint
 * shapes, response unwrapping, cache updates and the analytics events, none
 * of which may carry the link, its token or a child's name.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

import {
  useJoinLink,
  useCreateJoinLink,
  useRevokeJoinLink,
  useJoinRequests,
  useApproveJoinRequest,
  useDeclineJoinRequest,
  useJoinLinkPreview,
  useRequestToJoin,
  joinLinkKeys,
  type JoinLink,
  type JoinRequestRow,
} from '../../hooks/useJoinLink';
import { gameKeys, teamKeys } from '../../hooks/query-keys';
import { apiClient } from '../../services/api-client';
import { createQueryWrapper } from '../utils/queryWrapper';
import { trackEvent } from '../../services/analytics';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedTrack = trackEvent as jest.Mock;

const TOKEN = 'joinSecretToken_0123456789abcdefghijklmnopq';

const link: JoinLink = {
  id: 'link-1',
  teamId: 't1',
  url: `https://hooplings.com/join/${TOKEN}`,
  expiresAt: '2026-12-06T00:00:00Z',
  maxUses: null,
  useCount: 0,
  createdAt: '2026-11-22T00:00:00Z',
};

const request: JoinRequestRow = {
  id: 'req-1',
  kind: 'CHILD',
  status: 'PENDING',
  createdAt: '2026-11-22T00:00:00Z',
  childName: 'Riley Park',
  relationship: 'MOTHER',
  requester: { id: 'u-parent', name: 'Pat Parent', email: 'pat@example.com', isManaged: false, deletedAt: null },
};

/** No analytics call may carry the link, its token or a name. */
function expectNoSecretsTracked(): void {
  const sent = JSON.stringify(mockedTrack.mock.calls);
  expect(sent).not.toContain(TOKEN);
  expect(sent).not.toContain('hooplings.com');
  expect(sent).not.toContain('Riley');
  expect(sent).not.toContain('Pat');
}

describe('useJoinLink runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('the coach side', () => {
    it('useJoinLink fetches GET /teams/:id/join-link and unwraps `link`', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true, link } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useJoinLink('t1', true), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(link);
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/join-link');
    });

    it('useJoinLink resolves to null when the team has no live link', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true, link: null } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useJoinLink('t1', true), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBeNull();
    });

    it('neither the link nor the requests are fetched for a caller who cannot manage the roster', () => {
      const { wrapper } = createQueryWrapper();
      const linkHook = renderHook(() => useJoinLink('t1', false), { wrapper });
      const requestsHook = renderHook(() => useJoinRequests('t1', false), { wrapper });

      expect(linkHook.result.current.fetchStatus).toBe('idle');
      expect(requestsHook.result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('useCreateJoinLink posts, puts the new link in the cache and reports ids only', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true, link } });
      const { wrapper, client } = createQueryWrapper();
      const { result } = renderHook(() => useCreateJoinLink(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1' });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/join-link', {});
      expect(client.getQueryData(joinLinkKeys.link('t1'))).toEqual(link);
      expect(mockedTrack).toHaveBeenCalledWith('join_link_created', {
        team_id: 't1',
        link_id: 'link-1',
        has_max_uses: false,
      });
      expectNoSecretsTracked();
    });

    it('useCreateJoinLink sends the chosen options', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true, link: { ...link, maxUses: 20 } } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useCreateJoinLink(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', data: { expiresInDays: 7, maxUses: 20 } });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/join-link', { expiresInDays: 7, maxUses: 20 });
      expect(mockedTrack).toHaveBeenCalledWith('join_link_created', expect.objectContaining({ has_max_uses: true }));
    });

    it('useRevokeJoinLink posts and clears the cached link', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true, revoked: 1 } });
      const { wrapper, client } = createQueryWrapper();
      client.setQueryData(joinLinkKeys.link('t1'), link);
      const cancelSpy = jest.spyOn(client, 'cancelQueries');
      const { result } = renderHook(() => useRevokeJoinLink(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1' });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/join-link/revoke');
      expect(client.getQueryData(joinLinkKeys.link('t1'))).toBeNull();
      // An in-flight poll is cancelled before the cache is written.
      expect(cancelSpy).toHaveBeenCalledWith({ queryKey: joinLinkKeys.link('t1') });
      expect(mockedTrack).toHaveBeenCalledWith('join_link_revoked', { team_id: 't1' });
    });

    it('useJoinRequests fetches GET /teams/:id/join-requests and unwraps `requests`', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true, requests: [request] } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useJoinRequests('t1', true), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([request]);
      expect(mockedGet).toHaveBeenCalledWith('/teams/t1/join-requests');
    });

    it('useApproveJoinRequest posts, refreshes the requests and the roster, and never tracks the name', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useApproveJoinRequest(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', request });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/join-requests/req-1/approve');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: joinLinkKeys.requests('t1') });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
      expect(mockedTrack).toHaveBeenCalledWith('join_request_approved', {
        team_id: 't1',
        request_id: 'req-1',
        kind: 'child',
      });
      expectNoSecretsTracked();
    });

    it('useDeclineJoinRequest posts and refreshes the requests only', async () => {
      mockedPost.mockResolvedValueOnce({ data: { success: true } });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useDeclineJoinRequest(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ teamId: 't1', requestId: 'req-1' });
      });

      expect(mockedPost).toHaveBeenCalledWith('/teams/t1/join-requests/req-1/decline');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: joinLinkKeys.requests('t1') });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: teamKeys.detail('t1') });
      expect(mockedTrack).toHaveBeenCalledWith('join_request_declined', { team_id: 't1', request_id: 'req-1' });
    });
  });

  it('useJoinLink and the public preview ask the server on every mount, whatever is cached', async () => {
    mockedGet.mockImplementation(async (url: string) =>
      url === '/teams/t1/join-link'
        ? { data: { success: true, link: null } }
        : { data: { success: true, link: { teamName: 'Hornets', state: 'expired' } } }
    );
    const { wrapper, client } = createQueryWrapper();
    // Fresh cache entries from a moment ago: a live link and an active preview.
    client.setQueryData(joinLinkKeys.link('t1'), link);
    client.setQueryData(joinLinkKeys.preview(TOKEN), { teamName: 'Hornets', state: 'active' });

    const coach = renderHook(() => useJoinLink('t1', true), { wrapper });
    const family = renderHook(() => useJoinLinkPreview(TOKEN), { wrapper });

    // The server's answer replaces the cached one: the link is gone, the preview expired.
    await waitFor(() => expect(coach.result.current.data).toBeNull());
    await waitFor(() => expect(family.result.current.data).toEqual({ teamName: 'Hornets', state: 'expired' }));
  });

  it('useJoinRequests re-reads on every mount, even with a fresh cached list', async () => {
    mockedGet.mockResolvedValue({ data: { success: true, requests: [request] } });
    const { wrapper, client } = createQueryWrapper();
    client.setQueryData(joinLinkKeys.requests('t1'), []);
    const { result } = renderHook(() => useJoinRequests('t1', true), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual([request]));
    expect(mockedGet).toHaveBeenCalledWith('/teams/t1/join-requests');
  });

  describe('the family side', () => {
    it('useJoinLinkPreview fetches GET /join/:token and unwraps `link`', async () => {
      mockedGet.mockResolvedValueOnce({ data: { success: true, link: { teamName: 'Hornets', state: 'active' } } });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useJoinLinkPreview(TOKEN), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ teamName: 'Hornets', state: 'active' });
      expect(mockedGet).toHaveBeenCalledWith(`/join/${TOKEN}`);
    });

    it('useJoinLinkPreview is disabled without a token', () => {
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useJoinLinkPreview(undefined), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('useRequestToJoin posts a child request and reports the kind and outcome, never the name', async () => {
      mockedPost.mockResolvedValueOnce({
        data: {
          success: true,
          status: 'pending',
          created: true,
          teamName: 'Hornets',
          request: { id: 'req-1', kind: 'CHILD', status: 'PENDING', createdAt: '2026-11-22T00:00:00Z' },
        },
      });
      const { wrapper } = createQueryWrapper();
      const { result } = renderHook(() => useRequestToJoin(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.mutateAsync({
          token: TOKEN,
          data: { kind: 'child', childName: 'Riley Park', relationship: 'MOTHER' },
        });
      });

      expect(mockedPost).toHaveBeenCalledWith(`/join/${TOKEN}`, {
        kind: 'child',
        childName: 'Riley Park',
        relationship: 'MOTHER',
      });
      expect(returned).toEqual({ status: 'pending', created: true, teamName: 'Hornets' });
      expect(mockedTrack).toHaveBeenCalledWith('join_request_sent', {
        kind: 'child',
        outcome: 'pending',
        created: true,
      });
      expectNoSecretsTracked();
    });

    it('useRequestToJoin: an account already on the team refreshes the team and game lists', async () => {
      mockedPost.mockResolvedValueOnce({
        data: { success: true, status: 'already_member', teamId: 't1', teamName: 'Hornets' },
      });
      const { wrapper, client } = createQueryWrapper();
      const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
      const { result } = renderHook(() => useRequestToJoin(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.mutateAsync({ token: TOKEN, data: { kind: 'self' } });
      });

      expect(returned).toEqual({ status: 'already_member', teamId: 't1', teamName: 'Hornets' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: teamKeys.lists() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: gameKeys.lists() });
      expect(mockedTrack).toHaveBeenCalledWith('join_request_sent', {
        kind: 'self',
        outcome: 'already_member',
        created: false,
      });
    });
  });
});
