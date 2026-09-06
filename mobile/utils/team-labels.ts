/**
 * Team bracket labels (#462): age group + gender on the team-season row.
 *
 * Derived values are never inlined in a screen (same rule as
 * `utils/game-result.ts`): the create/edit forms, the team detail card and the
 * tests all go through these helpers.
 */

import type { TeamGender } from '../hooks/useTeams';

export const TEAM_GENDERS: readonly TeamGender[] = ['BOYS', 'GIRLS', 'COED'];

const GENDER_KEYS: Record<TeamGender, string> = {
  BOYS: 'teams.genderBoys',
  GIRLS: 'teams.genderGirls',
  COED: 'teams.genderCoed',
};

export function genderLabelKey(gender: TeamGender): string {
  return GENDER_KEYS[gender];
}

type Translate = (key: string) => string;

export function genderOptions(t: Translate): { key: TeamGender; label: string }[] {
  return TEAM_GENDERS.map((key) => ({ key, label: t(genderLabelKey(key)) }));
}

/**
 * "U14 · Boys", "U14", "Boys", or `null` when the team carries neither. A
 * backend predating the columns leaves both undefined, which reads as null.
 */
export function formatTeamBracket(
  team: { ageGroup?: string | null; gender?: TeamGender | null },
  t: Translate
): string | null {
  const parts = [team.ageGroup?.trim() || null, team.gender ? t(genderLabelKey(team.gender)) : null];
  const label = parts.filter((p): p is string => !!p).join(' · ');
  return label || null;
}
