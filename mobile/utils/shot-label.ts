/**
 * Shared display label for SHOT events.
 *
 * Free throws are SHOT events with `points: 1` and render as "FT"; field
 * goals render as "2pt" / "3pt". Both the tracker's UndoBanner message
 * (`app/games/[id]/track.tsx`) and the EventTimeline derive their shot text
 * through this helper — never inline the points branch in a screen (same
 * rule as `utils/game-result.ts`).
 */

import type { ShotMetadata } from '../types/game';

/** "FT" for free throws (points === 1), otherwise "2pt" / "3pt". */
export function getShotPointsLabel(points: number): string {
  return points === 1 ? 'FT' : `${points}pt`;
}

/**
 * Full shot description, e.g. "FT made", "2pt miss", "3pt made".
 * Missing metadata defaults to a 2-point miss (the legacy assumption).
 */
export function formatShotDescription(metadata: ShotMetadata | null | undefined): string {
  const points = metadata?.points || 2;
  const made = metadata?.made ?? false;
  return `${getShotPointsLabel(points)} ${made ? 'made' : 'miss'}`;
}
