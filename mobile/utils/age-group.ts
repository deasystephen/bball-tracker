/**
 * Youth age-group detection for the Add Player under-13 steer (#982, part of #980).
 *
 * `Team.ageGroup` is free text ("U10", "5th Grade", "12 & Under"), so the server
 * cannot enforce anything from it. The mobile Add Player form uses this only to
 * default "Is this player 13 or older?" to **No** on a team that reads as under
 * 13; the answer itself is never sent to the API or stored.
 *
 * A bracket counts when it can hold a player aged 12 or younger:
 * - `U13` / `13U` / "13 & under" count: an under-13 team's players are 12 or younger.
 * - A range that starts in an under-13 bracket ("U12-U14", "6th-8th Grade") counts
 *   too: some of its players are under 13, so No is the safer default there.
 * - Anything that does not match ("U14", "7th Grade", "Varsity", empty) gets **no**
 *   default, never a default Yes: outside youth brackets the coach must answer
 *   explicitly, because that answer backs the Terms warranty (#25).
 *
 * Not matched, on purpose: U14, 14U, Sub-14, 7th grade and up, and age ranges whose
 * top is 13 or more ("Ages 10-14"). The spec leaves those with no default.
 *
 * Derive, never inline: every caller asks `isUnder13AgeGroup`.
 */

/** 1–13: the number in U13 / 13U / "13 & under" / Sub-13 means "younger than 13". */
const UNDER_N = '(1[0-3]|[1-9])';
/** 1–12: the top of an age-in-years range ("Ages 8-10", "10 & younger") must be 12 or less. */
const AGE_MAX_12 = '(1[0-2]|[1-9])';
/** Optional plural or possessive suffix: "U12s", "12U's", "Under 10s". */
const PLURAL = "(?:'?s)?";
/** Optional range start in front of an age: "8-" in "8-10", "9 to " in "9 to 11". */
const RANGE_START = '(?:\\d{1,2}\\s*(?:-|–|to)\\s*)?';
/** Kindergarten through 6th grade (6th graders are typically 11–12). */
const GRADE_K_6 = '(K|[1-6])(st|nd|rd|th)?';

const YOUTH_AGE_GROUP_PATTERNS: readonly RegExp[] = [
  // U12, U-9, u10, U 10, U12s (and so the start of "U12-U14")
  new RegExp(`\\bU\\s*-?\\s*${UNDER_N}${PLURAL}\\b`, 'i'),
  // 12U, 9 U, 4u, 10-U, 12Us
  new RegExp(`\\b${UNDER_N}\\s*-?\\s*U${PLURAL}\\b`, 'i'),
  // Under 12, Under-10, under12, Under 10s
  new RegExp(`\\bunder\\s*-?\\s*${UNDER_N}${PLURAL}\\b`, 'i'),
  // Spanish: Sub-12, Sub 10, Menores de 12
  new RegExp(`\\bsub\\s*-?\\s*${UNDER_N}${PLURAL}\\b`, 'i'),
  new RegExp(`\\bmenor(es)?\\s+de\\s+${UNDER_N}\\b`, 'i'),
  // 12 & Under, 12 and under, 10-and-under
  new RegExp(`\\b${UNDER_N}\\s*-?\\s*(&|and)\\s*-?\\s*under\\b`, 'i'),
  // Ages 8-10, Age 9, Ages 9 to 11 (top 12 or less; "Ages 10-14" and "Ages 10+" do not count)
  new RegExp(`\\bages?\\s*${RANGE_START}${AGE_MAX_12}\\b(?!\\s*(?:-|–|to|\\+))`, 'i'),
  // 10 years and under, 10 yrs & under, 10 & younger, 10 and younger
  new RegExp(
    `\\b${AGE_MAX_12}\\s*(?:years?|yrs?)?\\s*(?:old\\s*)?(&|and)\\s*(under|younger)\\b`,
    'i'
  ),
  // 9-10 yo, 10 y.o., 8-10 years, 10 years old (not "10 years and up/older/over")
  new RegExp(
    `\\b${RANGE_START}${AGE_MAX_12}\\s*(?:yo|y\\.o\\.?|yrs?|years?)(?![a-z])(?!\\s*(?:old\\s*)?(?:&|and)\\s*(?:up|over|older))`,
    'i'
  ),
  // 3rd Grade, 5th-grade, K grade, 6th-8th Grade, 5th to 7th grade
  new RegExp(`\\b${GRADE_K_6}\\s*(?:(?:-|–|to)\\s*\\d{1,2}(st|nd|rd|th)?\\s*)?-?\\s*grade\\b`, 'i'),
  // Grade 5, Grade K, Grade-3, Grades 4-6
  new RegExp(`\\bgrades?\\s*-?\\s*(K|[1-6])\\b`, 'i'),
  // Kindergarten, Pre-K
  /\bkindergarten\b/i,
  /\bpre-?k\b/i,
];

/** True when a team's free-text age group names a bracket that can hold an under-13 player. */
export function isUnder13AgeGroup(ageGroup: string | null | undefined): boolean {
  if (!ageGroup) return false;
  return YOUTH_AGE_GROUP_PATTERNS.some((pattern) => pattern.test(ageGroup));
}
