/**
 * React Query hooks for Teams API
 */

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { usageKeys } from './useUsage';
import { playerKeys, teamKeys, invitationKeys, type TeamFilters } from './query-keys';
import type { TeamInvitationStatusRow } from '../utils/roster-status';
import type { GuardianRelationship } from '../../shared/types';

// Types
export interface TeamStaff {
  id: string;
  userId: string;
  user: {
    id: string;
    name: string;
    /** Only present when the caller has `canManageRoster` (GET /teams/:id/staff). */
    email?: string | null;
    isManaged?: boolean;
  };
  role: {
    id: string;
    name: string;
    type: 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER' | 'CUSTOM';
    canManageTeam: boolean;
    canManageRoster: boolean;
    canTrackStats: boolean;
    canViewStats: boolean;
    canShareStats: boolean;
  };
}

export interface TeamMember {
  id: string;
  playerId: string;
  jerseyNumber?: number | null;
  position?: string | null;
  player: {
    id: string;
    name: string;
    email?: string | null;
    isManaged?: boolean;
  };
}

export interface Team {
  id: string;
  name: string;
  seasonId: string;
  chatLink?: string | null;
  createdAt: string;
  updatedAt: string;
  season?: {
    id: string;
    name: string;
    isActive: boolean;
    league: {
      id: string;
      name: string;
    };
  };
  staff?: TeamStaff[];
  members?: TeamMember[];
  /**
   * Invite-status rows for ROSTERED players (unification spec). Present only
   * for callers with `canManageRoster` (others get `[]`); PENDING + ACCEPTED
   * only, never the token. Case-3 invites (existing accounts not yet on the
   * roster) come from `GET /invitations?teamId=` instead — dedupe by playerId.
   */
  invitations?: TeamInvitationStatusRow[];
  _count?: {
    members: number;
    staff: number;
    games: number;
  };
  roles?: {
    id: string;
    name: string;
    type: string;
  }[];
  games?: {
    id: string;
    opponent: string;
    date: string;
    status: string;
  }[];
}

export interface CreateTeamInput {
  name: string;
  seasonId: string;
  chatLink?: string;
}

export interface UpdateTeamInput {
  name?: string;
  seasonId?: string;
  chatLink?: string | null;
}

/**
 * Unified Add Player — `POST /teams/:teamId/players` (unification spec).
 * Name required; `playerEmail` decides whether an invitation goes out;
 * `guardianEmail` + `guardianRelationship` additionally invite a parent for
 * players who get a roster entry at creation (cases 1-2 — refused with a
 * reason for existing-account invitees, case 3).
 */
export interface AddRosterPlayerInput {
  name: string;
  playerEmail?: string;
  guardianEmail?: string;
  guardianRelationship?: GuardianRelationship;
  jerseyNumber?: number;
  position?: string;
  profilePictureUrl?: string;
}

export interface AddRosterPlayerResponse {
  success: boolean;
  /** false = case 3 (existing account) — roster entry appears on accept. */
  rostered: boolean;
  invited: boolean;
  member: TeamMember | null;
  invitation: {
    id: string;
    teamId: string;
    playerId: string;
    status: string;
    expiresAt: string;
  } | null;
  guardianInvited: boolean;
  /** Why the guardian invite did not happen (case 3, duplicate, ...). */
  guardianReason?: string;
  /**
   * Per-send delivery flags — false means the email failed; warn the coach.
   * Optional: a backend predating the unification deploy omits it (version
   * skew during an OTA window), so read it defensively.
   */
  emails?: { player?: boolean; guardian?: boolean };
}

export interface TeamsResponse {
  success: boolean;
  teams: Team[];
  total: number;
  limit: number;
  offset: number;
}

// Query keys live in ./query-keys (dependency-free, cycle-safe); re-exported
// here so existing imports keep working.
export { teamKeys };
export type { TeamFilters };

/** Default page size for paginated team lists (matches the server default). */
export const TEAMS_PAGE_SIZE = 20;
/** Server-side maximum `limit` for GET /teams — use for pickers that need every team. */
export const TEAMS_MAX_LIMIT = 100;

async function fetchTeamsPage(filters?: TeamFilters): Promise<TeamsResponse> {
  const params = new URLSearchParams();
  if (filters?.seasonId) params.append('seasonId', filters.seasonId);
  if (filters?.leagueId) params.append('leagueId', filters.leagueId);
  if (filters?.playerId) params.append('playerId', filters.playerId);
  if (filters?.limit) params.append('limit', String(filters.limit));
  if (filters?.offset) params.append('offset', String(filters.offset));

  const response = await apiClient.get<TeamsResponse>(`/teams?${params.toString()}`);
  const data = response.data;
  const teams = data.teams ?? [];
  return {
    success: data.success,
    teams,
    total: data.total ?? teams.length,
    limit: data.limit ?? filters?.limit ?? TEAMS_PAGE_SIZE,
    offset: data.offset ?? filters?.offset ?? 0,
  };
}

// Hooks

/**
 * Single page of teams (server default 20). Pass `{ limit: TEAMS_MAX_LIMIT }`
 * for pickers that need every team; use `useInfiniteTeams` for scrolling lists.
 */
export function useTeams(filters?: TeamFilters) {
  return useQuery({
    queryKey: teamKeys.list(filters),
    queryFn: async () => (await fetchTeamsPage(filters)).teams,
  });
}

/**
 * Infinite (paginated) teams list. Feed `fetchNextPage` to
 * `FlatList.onEndReached`. `total` is the server count across all pages.
 */
export function useInfiniteTeams(filters?: Omit<TeamFilters, 'offset'>) {
  const limit = filters?.limit ?? TEAMS_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: teamKeys.infinite(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchTeamsPage({ ...filters, limit, offset: pageParam }),
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.teams.length;
      return lastPage.teams.length < lastPage.limit || next >= lastPage.total ? undefined : next;
    },
    select: (data) => ({
      teams: data.pages.flatMap((page) => page.teams),
      total: data.pages[0]?.total ?? 0,
    }),
  });
}

export function useTeam(teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(teamId),
    queryFn: async () => {
      const response = await apiClient.get<{ success: boolean; team: Team }>(
        `/teams/${teamId}`
      );
      return response.data.team;
    },
    enabled: !!teamId,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateTeamInput) => {
      const response = await apiClient.post<{ success: boolean; team: Team }>('/teams', data);
      return response.data.team;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      // Team count feeds the FREE-tier usage meter (#43).
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
    },
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: UpdateTeamInput }) => {
      const response = await apiClient.patch<{ success: boolean; team: Team }>(
        `/teams/${teamId}`,
        data
      );
      return response.data.team;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (teamId: string) => {
      await apiClient.delete(`/teams/${teamId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
    },
  });
}

/**
 * Unified Add Player (replaces the dead `useAddPlayerToTeam`, which targeted
 * the pre-2026 endpoint shape, and the managed-player / create-and-invite
 * two-button split — unification spec).
 */
export function useAddRosterPlayer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, data }: { teamId: string; data: AddRosterPlayerInput }) => {
      const response = await apiClient.post<AddRosterPlayerResponse>(
        `/teams/${teamId}/players`,
        data
      );
      return response.data;
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      if (result.invited) {
        queryClient.invalidateQueries({ queryKey: invitationKeys.all });
      }
      if (variables.data.playerEmail || variables.data.guardianEmail) {
        // A new account may have been created; refresh player search
        queryClient.invalidateQueries({ queryKey: playerKeys.all });
      }
    },
  });
}

export function useRemovePlayerFromTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ teamId, playerId }: { teamId: string; playerId: string }) => {
      await apiClient.delete(`/teams/${teamId}/players/${playerId}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(variables.teamId) });
      // Team-card member counts (_count.members) live in the list payloads
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

export type TeamPermission =
  | 'canManageTeam'
  | 'canManageRoster'
  | 'canTrackStats'
  | 'canViewStats'
  | 'canShareStats';

/**
 * Minimal team shape the permission helpers need. Both `Team` (GET /teams/:id)
 * and the `game.team` payload (GET /games/:id) satisfy it.
 */
export interface TeamPermissionTarget {
  staff?: TeamStaff[];
  season?: { league?: { id: string } | null } | null;
}

/**
 * Effective team permission for the current user.
 *
 * Mirrors the backend (`utils/permissions.ts`): a system `ADMIN` passes every
 * check regardless of staff rows, an admin of the team's league passes every
 * check (`leagueAdminOf` comes from `GET /auth/me`; see
 * `utils/team-permissions.ts`), otherwise the user's staff role decides.
 */
export function hasTeamPermission(
  team: TeamPermissionTarget | undefined | null,
  userId: string | undefined,
  permission: TeamPermission,
  userRole?: string | null,
  leagueAdminOf?: string[] | null
): boolean {
  if (!team || !userId) return false;
  if (userRole === 'ADMIN') return true;

  const leagueId = team.season?.league?.id;
  if (leagueId && leagueAdminOf?.includes(leagueId)) return true;

  const staffMember = team.staff?.find((s) => s.userId === userId);
  if (!staffMember) return false;

  return staffMember.role[permission];
}

/**
 * Who may add / re-role / remove staff (role matrix decision 2, B2.3).
 *
 * Mirrors backend `utils/permissions.ts#canManageStaff`: system `ADMIN`,
 * an admin of the team's league, or a HEAD_COACH-type staff row. Head and
 * assistant coaches share the same permission flags, so this is keyed off
 * `role.type` rather than a flag.
 */
export function canManageStaff(
  team: TeamPermissionTarget | undefined | null,
  userId: string | undefined,
  userRole?: string | null,
  leagueAdminOf?: string[] | null
): boolean {
  if (!team || !userId) return false;
  if (userRole === 'ADMIN') return true;

  const leagueId = team.season?.league?.id;
  if (leagueId && leagueAdminOf?.includes(leagueId)) return true;

  return team.staff?.some((s) => s.userId === userId && s.role.type === 'HEAD_COACH') ?? false;
}

// Helper to check if user is a head coach
export function isHeadCoach(team: Team | undefined, userId: string | undefined): boolean {
  if (!team || !userId) return false;

  return team.staff?.some(
    (s) => s.userId === userId && s.role.type === 'HEAD_COACH'
  ) ?? false;
}

// Helper to get user's role on a team
export function getUserTeamRole(team: Team | undefined, userId: string | undefined): TeamStaff['role'] | null {
  if (!team || !userId) return null;

  const staffMember = team.staff?.find((s) => s.userId === userId);
  return staffMember?.role ?? null;
}
