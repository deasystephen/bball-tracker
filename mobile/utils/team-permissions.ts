/**
 * Client-side mirrors of the backend authorization rules. These only decide
 * what UI to show — the API is still the authority and rejects with 403.
 *
 * - `team-service.createTeam`: system ADMINs, COACHes and league admins.
 * - `league-service.createLeague` / `deleteLeague`: system ADMIN only.
 * - `season-service.createSeason` and the rest of league management: system
 *   ADMIN or an admin of that league (`utils/permissions.isLeagueAdmin`).
 *
 * League-admin membership reaches the client as `user.leagueAdminOf`
 * (`GET /auth/me` / `GET /auth/callback`). Older API builds omit the field;
 * `undefined` is treated as "admin of no leagues".
 */

import { UserRole } from '../../shared/types';

/** The slice of the auth-store user these checks need. */
export interface PermissionUser {
  role?: UserRole | string | null;
  leagueAdminOf?: string[] | null;
}

export function leagueAdminIds(user: PermissionUser | null | undefined): string[] {
  return user?.leagueAdminOf ?? [];
}

export function isSystemAdmin(user: PermissionUser | null | undefined): boolean {
  return user?.role === UserRole.ADMIN;
}

/** Admin of at least one league (system ADMINs count as admins of all). */
export function isAnyLeagueAdmin(user: PermissionUser | null | undefined): boolean {
  return isSystemAdmin(user) || leagueAdminIds(user).length > 0;
}

/** Mirrors the backend `isLeagueAdmin(userId, leagueId)`. */
export function isLeagueAdminOf(
  user: PermissionUser | null | undefined,
  leagueId: string | null | undefined
): boolean {
  if (isSystemAdmin(user)) return true;
  if (!leagueId) return false;
  return leagueAdminIds(user).includes(leagueId);
}

/** Who may open the "Leagues & Seasons" admin area. */
export function canAccessAdmin(user: PermissionUser | null | undefined): boolean {
  return isAnyLeagueAdmin(user);
}

/** League create/delete stay system-ADMIN only on the backend. */
export function canCreateLeagues(user: PermissionUser | null | undefined): boolean {
  return isSystemAdmin(user);
}

/** Season create/edit, league rename, league-admin management for one league. */
export function canManageLeague(
  user: PermissionUser | null | undefined,
  leagueId: string | null | undefined
): boolean {
  return isLeagueAdminOf(user, leagueId);
}

export function canCreateTeams(user: PermissionUser | null | undefined): boolean {
  return user?.role === UserRole.COACH || isAnyLeagueAdmin(user);
}
