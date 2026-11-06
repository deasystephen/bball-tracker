/**
 * Youth age-group detection for the Add Player under-13 steer (#982, part of #980).
 *
 * `Team.ageGroup` is free text ("U10", "5th Grade", "10U"), so the server cannot
 * enforce anything from it. The mobile Add Player form uses this only to default
 * the "Is this player 13 or older?" question to **No** on a team that reads as
 * under-13; the answer itself is never sent to the API or stored.
 *
 * Derive, never inline: every caller asks `isUnder13AgeGroup`.
 */

const YOUTH_AGE_GROUP_PATTERNS: readonly RegExp[] = [
  // U12, U-9, u10
  /\bU-?(1[0-2]|[1-9])\b/i,
  // K grade, 3rd grade, 6th Grade, 5 grade
  /\b(K|[1-6])(st|nd|rd|th)?\s*grade\b/i,
  // 12U, 9 U, 10u
  /\b(1[0-2]|[5-9])\s*U\b/i,
];

/** True when a team's free-text age group names an under-13 bracket. */
export function isUnder13AgeGroup(ageGroup: string | null | undefined): boolean {
  if (!ageGroup) return false;
  return YOUTH_AGE_GROUP_PATTERNS.some((pattern) => pattern.test(ageGroup));
}
