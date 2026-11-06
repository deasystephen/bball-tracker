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
    // plural and suffix forms
    'U12s',
    "U10's",
    '12Us',
    'Under 10s',
    // Spanish
    'Sub-12',
    'Sub 10',
    'sub12',
    'Menores de 12',
    'Menor de 10',
    // age in years, top 12 or less
    'Ages 8-10',
    'Age 9',
    'Ages 9 to 11',
    'Ages 11-12',
    '10 years and under',
    '10 yrs & under',
    '9-10 yo',
    '10 y.o.',
    '8-10 years',
    '10 years old',
    '10 & younger',
    '12 and younger',
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
    // The spec leaves these with no default: the coach must answer
    'U14s',
    '14Us',
    'Under 14s',
    'Sub-14',
    'Menores de 14',
    '7th grade',
    'Ages 10-14',
    'Ages 13-15',
    'Ages 10+',
    'Age 13',
    '13 years and under',
    '14 & younger',
    '13-14 yo',
    '10 years and up',
    '12 years and older',
    '15 years old',
    'Subway League',
  ])('does not treat %p as under 13', (ageGroup) => {
    expect(isUnder13AgeGroup(ageGroup)).toBe(false);
  });

  it('is false for a team with no age group', () => {
    expect(isUnder13AgeGroup(null)).toBe(false);
    expect(isUnder13AgeGroup(undefined)).toBe(false);
  });
});
