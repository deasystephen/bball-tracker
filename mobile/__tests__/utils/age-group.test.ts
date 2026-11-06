import { isUnder13AgeGroup } from '../../utils/age-group';

describe('isUnder13AgeGroup (#982)', () => {
  it.each([
    'U10',
    'u9',
    'U-12',
    'U1',
    'Boys U11',
    '3rd Grade',
    '1st grade',
    '6th Grade Girls',
    'K grade',
    '5 grade',
    '12U',
    '10u',
    '9 U',
    '5U',
  ])('treats %p as under 13', (ageGroup) => {
    expect(isUnder13AgeGroup(ageGroup)).toBe(true);
  });

  it.each([
    'U13',
    'U14',
    'U-18',
    '13U',
    '14u',
    '7th Grade',
    '8th grade',
    '12th Grade',
    'Varsity',
    'Adult',
    'Open',
    '',
    'U',
    'U100',
    '112U',
  ])('does not treat %p as under 13', (ageGroup) => {
    expect(isUnder13AgeGroup(ageGroup)).toBe(false);
  });

  it('is false for a team with no age group', () => {
    expect(isUnder13AgeGroup(null)).toBe(false);
    expect(isUnder13AgeGroup(undefined)).toBe(false);
  });
});
