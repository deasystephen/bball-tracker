/**
 * What the signed-in user may do with a game, mirroring the backend rules in
 * `game-service.ts` / `game-event-service.ts`:
 *
 * - create / edit / delete a game: `canManageTeam`
 * - change status or score: `canManageTeam` or `canTrackStats`
 *   (a FINISHED game additionally needs `canManageRoster` to reopen/rewrite)
 * - record / undo events: `canTrackStats`
 *
 * System ADMINs and league admins pass every check (see `hasTeamPermission`).
 */

import { hasTeamPermission, type TeamPermission, type TeamPermissionTarget } from '../hooks/useTeams';
import type { PermissionUser } from './team-permissions';

export interface GamePermissionUser extends PermissionUser {
  id: string;
}

export interface GamePermissions {
  /** Create / edit / delete the game. */
  canManage: boolean;
  /** Record and undo stat events (the tracker screen). */
  canTrack: boolean;
  /** Start / end the game and edit the score. */
  canChangeStatus: boolean;
  /** Reopen or rewrite a FINISHED game. */
  canEditFinished: boolean;
}

const NONE: GamePermissions = {
  canManage: false,
  canTrack: false,
  canChangeStatus: false,
  canEditFinished: false,
};

export function getGamePermissions(
  team: TeamPermissionTarget | undefined | null,
  user: GamePermissionUser | null | undefined
): GamePermissions {
  if (!team || !user) return NONE;
  const has = (flag: TeamPermission): boolean =>
    hasTeamPermission(team, user.id, flag, user.role, user.leagueAdminOf);

  const canManage = has('canManageTeam');
  const canTrack = has('canTrackStats');
  return {
    canManage,
    canTrack,
    canChangeStatus: canManage || canTrack,
    canEditFinished: has('canManageRoster'),
  };
}

/**
 * True when the user can manage at least one of the given teams — drives the
 * "create game" entry points, since creating a game needs `canManageTeam` on
 * the chosen team.
 */
export function canManageAnyTeam(
  teams: TeamPermissionTarget[] | undefined,
  user: GamePermissionUser | null | undefined
): boolean {
  if (!teams || !user) return false;
  return teams.some((team) =>
    hasTeamPermission(team, user.id, 'canManageTeam', user.role, user.leagueAdminOf)
  );
}
