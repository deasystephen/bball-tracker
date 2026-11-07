/**
 * The age screen's arithmetic (#981): the threshold per region and the
 * month-granular age it is compared with. Everything is UTC and pure.
 */
import {
  DEFAULT_MINIMUM_AGE,
  GDPR_MINIMUM_AGE,
  SIXTEEN_PLUS_REGIONS,
  ageInYears,
  meetsMinimumAge,
  minimumAgeFor,
} from '../../src/utils/minimum-age';

const NOW = new Date('2026-11-07T12:00:00Z');

describe('minimumAgeFor', () => {
  it('is 13 with no region, an unknown region or the US', () => {
    expect(minimumAgeFor(undefined)).toBe(DEFAULT_MINIMUM_AGE);
    expect(minimumAgeFor(null)).toBe(DEFAULT_MINIMUM_AGE);
    expect(minimumAgeFor('')).toBe(DEFAULT_MINIMUM_AGE);
    expect(minimumAgeFor('US')).toBe(13);
    expect(minimumAgeFor('CA')).toBe(13);
    expect(minimumAgeFor('ZZ')).toBe(13);
  });

  it('is 16 in the EU, the EEA, the UK and Switzerland, whatever the case', () => {
    for (const code of ['DE', 'fr', 'IE', 'NO', 'IS', 'LI', 'GB', 'uk', 'CH', 'GI', 'JE']) {
      expect(minimumAgeFor(code)).toBe(GDPR_MINIMUM_AGE);
    }
    expect(minimumAgeFor(' de ')).toBe(16);
  });

  it('lists all 27 EU states, 3 EEA states, 6 UK codes and Switzerland', () => {
    expect(SIXTEEN_PLUS_REGIONS.size).toBe(27 + 3 + 6 + 1);
  });
});

describe('ageInYears', () => {
  it('counts whole years, treating the birth month as reached only once it is over (the day is unknown)', () => {
    expect(ageInYears({ birthMonth: 10, birthYear: 2013 }, NOW)).toBe(13);
    expect(ageInYears({ birthMonth: 11, birthYear: 2013 }, NOW)).toBe(12);
    expect(ageInYears({ birthMonth: 12, birthYear: 2013 }, NOW)).toBe(12);
    expect(ageInYears({ birthMonth: 1, birthYear: 2013 }, NOW)).toBe(13);
    expect(ageInYears({ birthMonth: 10, birthYear: 2014 }, NOW)).toBe(12);
  });

  it('uses the UTC date', () => {
    // 23:30 UTC on 30 November is still November in UTC even where it is already December.
    const lateNovember = new Date('2026-11-30T23:30:00Z');
    expect(ageInYears({ birthMonth: 11, birthYear: 2013 }, lateNovember)).toBe(12);
    expect(ageInYears({ birthMonth: 11, birthYear: 2013 }, new Date('2026-12-01T00:00:00Z'))).toBe(13);
  });
});

describe('meetsMinimumAge', () => {
  it('passes 13 in the US and refuses 12', () => {
    expect(meetsMinimumAge({ birthMonth: 10, birthYear: 2013 }, 'US', NOW)).toBe(true);
    expect(meetsMinimumAge({ birthMonth: 11, birthYear: 2013 }, 'US', NOW)).toBe(false);
    expect(meetsMinimumAge({ birthMonth: 6, birthYear: 1990 }, undefined, NOW)).toBe(true);
  });

  it('needs 16 in a GDPR region: the same 15-year-old passes in the US and is refused in Germany', () => {
    const fifteen = { birthMonth: 5, birthYear: 2011 };
    expect(meetsMinimumAge(fifteen, 'US', NOW)).toBe(true);
    expect(meetsMinimumAge(fifteen, 'DE', NOW)).toBe(false);
    expect(meetsMinimumAge({ birthMonth: 10, birthYear: 2010 }, 'DE', NOW)).toBe(true);
    expect(meetsMinimumAge({ birthMonth: 11, birthYear: 2010 }, 'GB', NOW)).toBe(false);
  });
});
