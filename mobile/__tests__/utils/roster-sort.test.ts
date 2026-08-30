/**
 * Roster sort comparator: jersey order is asc with 0 valid and nulls last
 * (name tiebreak); name order is case-insensitive (jersey tiebreak). The
 * input array is never mutated.
 */

import { isRosterSortKey, sortRosterMembers } from '../../utils/roster-sort';

const member = (name: string, jerseyNumber: number | null) => ({
  jerseyNumber,
  player: { name },
});

const names = (members: { player: { name: string } }[]) => members.map((m) => m.player.name);

describe('sortRosterMembers', () => {
  it('sorts by jersey ascending with 0 first and nulls last', () => {
    const roster = [
      member('NoNumber', null),
      member('Twenty', 20),
      member('Zero', 0),
      member('Five', 5),
    ];
    expect(names(sortRosterMembers(roster, 'jersey'))).toEqual([
      'Zero',
      'Five',
      'Twenty',
      'NoNumber',
    ]);
  });

  it('breaks jersey ties (including two un-numbered players) by name', () => {
    const roster = [
      member('Zoe', 7),
      member('Bare B', null),
      member('Abe', 7),
      member('Bare A', null),
    ];
    expect(names(sortRosterMembers(roster, 'jersey'))).toEqual([
      'Abe',
      'Zoe',
      'Bare A',
      'Bare B',
    ]);
  });

  it('sorts by name case-insensitively with jersey tiebreak', () => {
    const roster = [
      member('carla', 3),
      member('Ben', null),
      member('Alma', 12),
      member('ben', 4),
    ];
    const sorted = sortRosterMembers(roster, 'name');
    expect(names(sorted)).toEqual(['Alma', 'ben', 'Ben', 'carla']);
    // The two Bens tie on name; jersey 4 comes before no jersey.
    expect(sorted[1].jerseyNumber).toBe(4);
  });

  it('treats accented and unaccented names as equal under base sensitivity', () => {
    // 'base' sensitivity compares Álvarez/Alvarez equal in every ICU build,
    // so the jersey tiebreak decides — deterministic across Jest and Hermes.
    const roster = [member('Álvarez', 2), member('Alvarez', 1)];
    const sorted = sortRosterMembers(roster, 'name');
    expect(sorted.map((m) => m.jerseyNumber)).toEqual([1, 2]);
  });

  it('does not mutate the input array', () => {
    const roster = [member('B', 2), member('A', 1)];
    const before = [...roster];
    sortRosterMembers(roster, 'jersey');
    expect(roster).toEqual(before);
  });
});

describe('isRosterSortKey', () => {
  it('accepts only the two known keys', () => {
    expect(isRosterSortKey('jersey')).toBe(true);
    expect(isRosterSortKey('name')).toBe(true);
    expect(isRosterSortKey('ppg')).toBe(false);
    expect(isRosterSortKey(null)).toBe(false);
    expect(isRosterSortKey(undefined)).toBe(false);
  });
});
