/**
 * The minimum age to hold a Hooplings account (#980, #981).
 *
 * Hooplings is a general-audience service whose account holders must be 13 or
 * older; a younger player is a roster record an adult maintains. In the EU,
 * the EEA, the UK and Switzerland the threshold is 16 (owner decision
 * 2026-11-07: one conservative figure for every region where GDPR Article 8 or
 * its UK and Swiss equivalents apply, rather than the per-country table).
 *
 * The age screen asks for a birth month and year only (the FTC's "neutral age
 * screen" guidance), and nothing about the answer is stored, so the check is a
 * pure function of the answer, the region and today's date, all in UTC.
 */

export const DEFAULT_MINIMUM_AGE = 13;
export const GDPR_MINIMUM_AGE = 16;

/**
 * ISO 3166-1 alpha-2 codes where the minimum is 16: the 27 EU member states,
 * the three EEA states, the UK (with its Crown dependencies and Gibraltar,
 * which follow UK law) and Switzerland.
 */
export const SIXTEEN_PLUS_REGIONS: ReadonlySet<string> = new Set([
  // EU
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA
  'IS', 'LI', 'NO',
  // UK and territories applying UK data-protection law
  'GB', 'UK', 'GG', 'JE', 'IM', 'GI',
  // Switzerland
  'CH',
]);

/** The minimum age for a device whose region setting is `regionCode` (any case; unknown or absent → 13). */
export function minimumAgeFor(regionCode: string | null | undefined): number {
  if (!regionCode) return DEFAULT_MINIMUM_AGE;
  return SIXTEEN_PLUS_REGIONS.has(regionCode.trim().toUpperCase()) ? GDPR_MINIMUM_AGE : DEFAULT_MINIMUM_AGE;
}

export interface BirthMonthYear {
  /** 1–12 */
  birthMonth: number;
  birthYear: number;
}

/**
 * Whole years since the birth month, as of `now` (UTC). The day is unknown, so
 * the birthday counts as reached once the calendar reaches the birth month:
 * someone born in March 2013 is 13 from 1 March 2026. The alternative (counting
 * the month only once it is over) would refuse, and un-claim or erase, the
 * account of a person who is already old enough for most of their birth month;
 * the rounding runs the other way for at most 30 days, once, which the FTC's
 * "actual knowledge" standard does not reach. Documented in
 * `docs/architecture/children-and-age.md`.
 */
export function ageInYears({ birthMonth, birthYear }: BirthMonthYear, now: Date = new Date()): number {
  const years = now.getUTCFullYear() - birthYear;
  return now.getUTCMonth() + 1 < birthMonth ? years - 1 : years;
}

/** True when the answer meets the minimum age for the region. */
export function meetsMinimumAge(
  answer: BirthMonthYear,
  regionCode: string | null | undefined,
  now: Date = new Date()
): boolean {
  return ageInYears(answer, now) >= minimumAgeFor(regionCode);
}
