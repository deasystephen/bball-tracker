/**
 * Who may create teams, mirrored from the backend rule in
 * `team-service.createTeam`: system ADMINs and COACHes (plus league admins,
 * which the API does not yet expose to the client — see CLAUDE.md follow-up
 * for audit #65/#79). Players are invited onto teams by a coach.
 */

import { UserRole } from '../../shared/types';

export function canCreateTeams(role: UserRole | string | null | undefined): boolean {
  return role === UserRole.COACH || role === UserRole.ADMIN;
}
