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

function staffRoleLabelKey(type: string): string | null {
  return Object.prototype.hasOwnProperty.call(ROLE_LABEL_KEY, type)
    ? ROLE_LABEL_KEY[type as StaffRoleType]
    : null;
}

/** The translated label, or `fallback` (default: the generic staff noun key's value) for an unknown type. */
export function staffRoleLabel(t: (key: string) => string, type: string, fallback?: string): string {
  const key = staffRoleLabelKey(type);
  return key ? t(key) : (fallback ?? t('teams.staffMember'));
}

/**
 * What a staff accept tells the invitee (#460): the team and role joined, or
 * that an account already on the staff kept its role (accept never re-roles).
 */
export function staffAcceptedMessage(
  t: (key: string, options?: Record<string, unknown>) => string,
  invitation: { teamName: string; roleType: string },
  alreadyStaff: boolean | undefined
): string {
  return alreadyStaff
    ? t('invite.alreadyStaff', { team: invitation.teamName })
    : t('invite.joinedStaff', { team: invitation.teamName, role: staffRoleLabel(t, invitation.roleType) });
}
