/**
 * Team bracket helpers (#462). Screens never inline these derivations.
 */

import { formatTeamBracket, genderLabelKey, genderOptions, TEAM_GENDERS } from '../../utils/team-labels';
import { i18n } from '../../i18n';

const t = (key: string): string => i18n.t(key);

describe('formatTeamBracket', () => {
  it('joins age group and gender with a middle dot', () => {
    expect(formatTeamBracket({ ageGroup: 'U14', gender: 'BOYS' }, t)).toBe('U14 · Boys');
  });

  it('renders either half on its own', () => {
    expect(formatTeamBracket({ ageGroup: 'Grade 7', gender: null }, t)).toBe('Grade 7');
    expect(formatTeamBracket({ ageGroup: null, gender: 'COED' }, t)).toBe('Coed');
  });

  it('is null when the team carries neither, including a backend that omits both fields', () => {
    expect(formatTeamBracket({ ageGroup: null, gender: null }, t)).toBeNull();
    expect(formatTeamBracket({}, t)).toBeNull();
    expect(formatTeamBracket({ ageGroup: '   ' }, t)).toBeNull();
  });
});

describe('gender options', () => {
  it('covers every enum value with real locale copy, in a stable order', () => {
    expect(TEAM_GENDERS).toEqual(['BOYS', 'GIRLS', 'COED']);
    expect(genderOptions(t)).toEqual([
      { key: 'BOYS', label: 'Boys' },
      { key: 'GIRLS', label: 'Girls' },
      { key: 'COED', label: 'Coed' },
    ]);
    expect(genderLabelKey('GIRLS')).toBe('teams.genderGirls');
  });
});
