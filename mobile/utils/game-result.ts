/**
 * Win / loss / tie helpers shared by every screen that renders a game
 * outcome. Scores are from the tracked team's point of view (homeScore is
 * "us", awayScore is the opponent). Ties are rendered as a neutral "T", never
 * as a loss (audit #56).
 */

import type { Colors } from '../theme/colors';

export type GameResult = 'W' | 'L' | 'T';

export function getGameResult(homeScore: number, awayScore: number): GameResult {
  if (homeScore > awayScore) return 'W';
  if (homeScore < awayScore) return 'L';
  return 'T';
}

/** Colour for a result badge/stripe: success for W, error for L, neutral for T. */
export function getResultColor(result: GameResult, colors: Colors): string {
  switch (result) {
    case 'W':
      return colors.success;
    case 'L':
      return colors.error;
    case 'T':
      return colors.textSecondary;
  }
}

/**
 * "10-5" normally, "10-5-1" once a team has at least one tie, so the record
 * never silently drops games.
 */
export function formatRecord(wins: number, losses: number, ties = 0): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}
