import { isUnder13AgeGroup } from '../../utils/age-group';

describe('isUnder13AgeGroup (#982)', () => {
  it.each([
    // U-number
    'U10',
    'u9',
    'U-12',
    'U 10',
    'U1',
    'U4',
    'Boys U11',
    // U13 is "under 13": its players are 12 or younger
    'U13',
    // number-U, agreeing with U-number
    '12U',
    '10u',
    '9 U',
    '4U',
    '1U',
    '13U',
    // spelled out
    'Under 12',
    'under-10',
    'Under 13',
    '12 & Under',
    '12 and under',
    '10-and-under',
    '13 & Under',
    // grades
    '3rd Grade',
    '1st grade',
    '5th-grade',
    '6th Grade Girls',
    'K grade',
    '5 grade',
    'Grade 5',
    'grade K',
    'Grades 4-6',
    'Kindergarten',
    'Pre-K',
  ])('treats %p as under 13', (ageGroup) => {
    expect(isUnder13AgeGroup(ageGroup)).toBe(true);
  });

  it.each(['U12-U14', '6th-8th Grade', '5th to 7th grade', 'U11/U12'])(
    'treats the range %p as under 13: some of its players are, so No is the safer default',
    (ageGroup) => {
      expect(isUnder13AgeGroup(ageGroup)).toBe(true);
    }
  );

  it.each([
    'U14',
    'U-18',
    'U 15',
    '14U',
    '14u',
    'Under 14',
    '14 & Under',
    '7th Grade',
    '8th grade',
    '12th Grade',
    'Grade 7',
    'Grade 12',
    'Varsity',
    'JV',
    'Adult',
    'Open',
    'High School',
    '',
    'U',
    'U100',
    '112U',
    'Under',
  ])('does not treat %p as under 13', (ageGroup) => {
    expect(isUnder13AgeGroup(ageGroup)).toBe(false);
  });

  it('is false for a team with no age group', () => {
    expect(isUnder13AgeGroup(null)).toBe(false);
    expect(isUnder13AgeGroup(undefined)).toBe(false);
  });
});
