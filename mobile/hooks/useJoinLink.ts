/**
 * React Query hooks for team join links (#210): the link a coach shares so
 * families ask to join, and the requests a roster manager approves.
 *
 * The link's URL carries a bearer token. It is fetched only for callers who
 * may manage the roster (the API answers 403 otherwise), kept in the query
 * cache like any other response, and never logged or sent to analytics.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';
import type { GuardianRelationship } from '../../shared/types';
import { gameKeys, teamKeys } from './query-keys';

/** The team's live link, as roster managers receive it. `url` is what gets shared. */
export interface JoinLink {
  id: string;
  teamId: string;
  url: string;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
}

export type JoinRequestKind = 'SELF' | 'CHILD';

/** A pending request on the coach's list. */
export interface JoinRequestRow {
  id: string;
  kind: JoinRequestKind;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  createdAt: string;
  childName: string | null;
  relationship: GuardianRelationship | null;
  requester: { id: string; name: string; email: string | null; isManaged: boolean; deletedAt: string | null };
}

/** What a link holder may know: the team's name and whether the link still takes requests. */
export interface JoinLinkPreview {
  teamName: string;
  state: 'active' | 'expired' | 'full';
}

export type JoinRequestInput =
  | { kind: 'self' }
  | { kind: 'child'; childName: string; relationship: GuardianRelationship };

export type JoinRequestResult =
  | { status: 'already_member'; teamId: string; teamName: string }
  | { status: 'pending'; created: boolean; teamName: string };

export interface CreateJoinLinkInput {
  expiresInDays?: number;
  maxUses?: number | null;
}

export const joinLinkKeys = {
  all: ['join-link'] as const,
  link: (teamId: string) => [...joinLinkKeys.all, 'link', teamId] as const,
  requests: (teamId: string) => [...joinLinkKeys.all, 'requests', teamId] as const,
  preview: (token: string | undefined) => [...joinLinkKeys.all, 'preview', token] as const,
};

/** True once a link's `expiresAt` has passed: the server no longer serves it either. */
export function isJoinLinkExpired(link: Pick<JoinLink, 'expiresAt'>, now: Date = new Date()): boolean {
  return new Date(link.expiresAt).getTime() <= now.getTime();
}

/** The team's live join link, or `null`. Pass `enabled` from `canManageRoster`. */
export function useJoinLink(teamId: string, enabled: boolean) {
  return useQuery({
    // A link can be replaced or turned off from another coach's phone.
    refetchOnMount: 'always',
    queryKey: joinLinkKeys.link(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; link: JoinLink | null }>(
        `/teams/${teamId}/join-link`
      );
      return response.data.link ?? null;
    },
    enabled: !!teamId && enabled,
  });
}

/** Create the team's link. The live one, if any, stops working (this is also "New link"). */
export function useCreateJoinLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data?: CreateJoinLinkInput }) => {
      const response = await apiClient.post<{ success: boolean; link: JoinLink }>(
        `/teams/${teamId}/join-link`,
        data ?? {}
      );
      return response.data.link;
    },
    onSuccess: (link, variables) => {
      trackEvent(AnalyticsEvents.JOIN_LINK_CREATED, {
        team_id: variables.teamId,
        link_id: link.id,
        has_max_uses: link.maxUses != null,
      });
      queryClient.setQueryData(joinLinkKeys.link(variables.teamId), link);
    },
  });
}

/** Turn the team's link off. Requests already waiting stay on the list. */
export function useRevokeJoinLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId }: { teamId: string }) => {
      await apiClient.post(`/teams/${teamId}/join-link/revoke`);
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.JOIN_LINK_REVOKED, { team_id: variables.teamId });
      queryClient.setQueryData(joinLinkKeys.link(variables.teamId), null);
    },
  });
}

/** How often the join link screen re-reads the requests while it is open. */
export const JOIN_REQUESTS_POLL_MS = 15_000;

/**
 * Pending join requests of a team. Pass `enabled` from `canManageRoster`.
 *
 * Requests arrive from other people's phones, so a cached list is never
 * trusted: every mount re-reads it (the team screen's count, and the screen a
 * "New join request" push opens), and with `poll` the join link screen
 * re-reads it every `JOIN_REQUESTS_POLL_MS`, because a coach holding up the
 * QR code is watching for exactly that.
 */
export function useJoinRequests(teamId: string, enabled: boolean, options: { poll?: boolean } = {}) {
  return useQuery({
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: options.poll ? JOIN_REQUESTS_POLL_MS : false,
    queryKey: joinLinkKeys.requests(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; requests: JoinRequestRow[] }>(
        `/teams/${teamId}/join-requests`
      );
      return response.data.requests ?? [];
    },
    enabled: !!teamId && enabled,
  });
}

/** Approve a request: the player (or the child, with the parent as guardian) joins the roster. */
export function useApproveJoinRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, request }: { teamId: string; request: Pick<JoinRequestRow, 'id' | 'kind'> }) => {
      await apiClient.post(`/teams/${teamId}/join-requests/${request.id}/approve`);
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.JOIN_REQUEST_APPROVED, {
        team_id: variables.teamId,
        request_id: variables.request.id,
        kind: variables.request.kind === 'CHILD' ? 'child' : 'self',
      });
      queryClient.invalidateQueries({ queryKey: joinLinkKeys.requests(variables.teamId) });
      // The roster changed.
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

/** Decline a request. Nothing is added to the roster. */
export function useDeclineJoinRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, requestId }: { teamId: string; requestId: string }) => {
      await apiClient.post(`/teams/${teamId}/join-requests/${requestId}/decline`);
    },
    onSuccess: (_, variables) => {
      trackEvent(AnalyticsEvents.JOIN_REQUEST_DECLINED, {
        team_id: variables.teamId,
        request_id: variables.requestId,
      });
      queryClient.invalidateQueries({ queryKey: joinLinkKeys.requests(variables.teamId) });
    },
  });
}

/** Public preview of a join link (no session needed): the team's name and the link's state. */
export function useJoinLinkPreview(token: string | undefined) {
  return useQuery({
    queryKey: joinLinkKeys.preview(token),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; link: JoinLinkPreview }>(`/join/${token}`);
      return response.data.link;
    },
    enabled: !!token,
    retry: false,
  });
}

/** Ask to join the link's team, as yourself or for your child. A coach approves. */
export function useRequestToJoin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ token, data }: { token: string; data: JoinRequestInput }): Promise<JoinRequestResult> => {
      const response = await apiClient.post<{ success: boolean } & JoinRequestResult>(`/join/${token}`, data);
      const body = response.data;
      return body.status === 'already_member'
        ? { status: body.status, teamId: body.teamId, teamName: body.teamName }
        : { status: body.status, created: body.created, teamName: body.teamName };
    },
    onSuccess: (result, variables) => {
      trackEvent(AnalyticsEvents.JOIN_REQUEST_SENT, {
        kind: variables.data.kind,
        outcome: result.status,
        created: result.status === 'pending' && result.created,
      });
      if (result.status === 'already_member') {
        // The caller is on a team this device may not have listed yet.
        queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
        queryClient.invalidateQueries({ queryKey: gameKeys.lists() });
      }
    },
  });
}
