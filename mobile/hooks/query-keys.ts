/**
 * TanStack Query key factories, dependency-free so any hook module can import
 * any factory without cycles (useTeams ↔ useInvitations both need each
 * other's keys for cross-invalidation — roster chips live in the team
 * payload, invitations drive them). Never hardcode a key array in a hook;
 * a drifted literal silently stops invalidating.
 */

export interface TeamFilters {
  seasonId?: string;
  leagueId?: string;
  playerId?: string;
  limit?: number;
  offset?: number;
}

export interface InvitationsQueryParams {
  status?: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  teamId?: string;
  playerId?: string;
  limit?: number;
  offset?: number;
}

export const teamKeys = {
  all: ['teams'] as const,
  lists: () => [...teamKeys.all, 'list'] as const,
  list: (filters?: TeamFilters) => [...teamKeys.lists(), filters] as const,
  infinite: (filters?: Omit<TeamFilters, 'offset'>) =>
    [...teamKeys.lists(), 'infinite', filters] as const,
  details: () => [...teamKeys.all, 'detail'] as const,
  detail: (id: string) => [...teamKeys.details(), id] as const,
};

export const invitationKeys = {
  all: ['invitations'] as const,
  lists: () => [...invitationKeys.all, 'list'] as const,
  list: (params?: InvitationsQueryParams) => [...invitationKeys.lists(), params] as const,
  details: () => [...invitationKeys.all, 'detail'] as const,
  detail: (id: string) => [...invitationKeys.details(), id] as const,
  team: (teamId: string) => [...invitationKeys.all, 'team', teamId] as const,
  player: (playerId: string) => [...invitationKeys.all, 'player', playerId] as const,
};
