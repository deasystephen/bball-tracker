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

// Every invitation query keys under lists()/list(params) — including the
// team-scoped useTeamInvitations — so lists() is the covering invalidation
// key for team-scoped coherence. (Bespoke team()/player() sub-keys existed
// once, subscribed to by nothing; red-team review removed them before a
// "scope it down" refactor could silently stop refreshing the Invited
// section.)
export const invitationKeys = {
  all: ['invitations'] as const,
  lists: () => [...invitationKeys.all, 'list'] as const,
  list: (params?: InvitationsQueryParams) => [...invitationKeys.lists(), params] as const,
  details: () => [...invitationKeys.all, 'detail'] as const,
  detail: (id: string) => [...invitationKeys.details(), id] as const,
};

export interface PlayersQueryParams {
  search?: string;
  role?: 'PLAYER' | 'COACH' | 'PARENT' | 'ADMIN';
  limit?: number;
  offset?: number;
}

export const playerKeys = {
  all: ['players'] as const,
  lists: () => [...playerKeys.all, 'list'] as const,
  list: (params?: PlayersQueryParams) => [...playerKeys.lists(), params] as const,
  details: () => [...playerKeys.all, 'detail'] as const,
  detail: (id: string) => [...playerKeys.details(), id] as const,
};
