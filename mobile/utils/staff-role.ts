/**
 * The i18n key for a staff role type's label. One place for the staff
 * screen, its pending invitations and the staff invitation views (#460).
 * A type this build does not know (a newer API, a CUSTOM role) has none.
 */
import type { StaffRoleType } from '../hooks/useTeamStaff';

const ROLE_LABEL_KEY: Record<StaffRoleType, string> = {
  HEAD_COACH: 'teams.roleHeadCoach',
  ASSISTANT_COACH: 'teams.roleAssistantCoach',
  TEAM_MANAGER: 'teams.roleTeamManager',
};

export function staffRoleLabelKey(type: string): string | null {
  return Object.prototype.hasOwnProperty.call(ROLE_LABEL_KEY, type)
    ? ROLE_LABEL_KEY[type as StaffRoleType]
    : null;
}

/** The translated label, or `fallback` (default: the generic staff noun key's value) for an unknown type. */
export function staffRoleLabel(t: (key: string) => string, type: string, fallback?: string): string {
  const key = staffRoleLabelKey(type);
  return key ? t(key) : (fallback ?? t('teams.staffMember'));
}
