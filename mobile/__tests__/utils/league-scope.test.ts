/**
 * Personal-league scoping helper (#442).
 */

import { areAllLeaguesPersonal, isPersonalLeague } from '../../utils/league-scope';

describe('isPersonalLeague', () => {
  it('is true only for an explicit isPersonal flag', () => {
    expect(isPersonalLeague({ isPersonal: true })).toBe(true);
    expect(isPersonalLeague({ isPersonal: false })).toBe(false);
    // Backend predating #442 omits the field entirely.
    expect(isPersonalLeague({})).toBe(false);
  });
});

describe('areAllLeaguesPersonal', () => {
  it('treats an empty or missing list as all-personal (brand-new coach)', () => {
    expect(areAllLeaguesPersonal([])).toBe(true);
    expect(areAllLeaguesPersonal(undefined)).toBe(true);
    expect(areAllLeaguesPersonal(null)).toBe(true);
  });

  it('is true when the only league is the coach\'s own personal container', () => {
    // Second-team case: the list is NON-EMPTY, so a count check gets this wrong.
    expect(areAllLeaguesPersonal([{ isPersonal: true }])).toBe(true);
    expect(areAllLeaguesPersonal([{ isPersonal: true }, { isPersonal: true }])).toBe(true);
  });

  it('is false as soon as one real league is visible', () => {
    expect(areAllLeaguesPersonal([{ isPersonal: false }])).toBe(false);
    expect(areAllLeaguesPersonal([{ isPersonal: true }, { isPersonal: false }])).toBe(false);
    // Version skew: no flag -> show the picker, the pre-#442 behaviour.
    expect(areAllLeaguesPersonal([{}])).toBe(false);
  });
});
