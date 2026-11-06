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
 * Derive, never inline: every caller asks `isUnder13AgeGroup`.
 */

/** 1–13: the number in U13 / 13U / "13 & under" means "younger than 13". */
const UNDER_N = '(1[0-3]|[1-9])';
/** Kindergarten through 6th grade (6th graders are typically 11–12). */
const GRADE_K_6 = '(K|[1-6])(st|nd|rd|th)?';

const YOUTH_AGE_GROUP_PATTERNS: readonly RegExp[] = [
  // U12, U-9, u10, U 10 (and so the start of "U12-U14")
  new RegExp(`\\bU\\s*-?\\s*${UNDER_N}\\b`, 'i'),
  // 12U, 9 U, 4u, 10-U
  new RegExp(`\\b${UNDER_N}\\s*-?\\s*U\\b`, 'i'),
  // Under 12, Under-10, under12
  new RegExp(`\\bunder\\s*-?\\s*${UNDER_N}\\b`, 'i'),
  // 12 & Under, 12 and under, 10-and-under
  new RegExp(`\\b${UNDER_N}\\s*-?\\s*(&|and)\\s*-?\\s*under\\b`, 'i'),
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
