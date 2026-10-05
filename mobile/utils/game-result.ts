/**
 * Win / loss / tie helpers shared by every screen that renders a game
 * outcome. Scores are from the tracked team's point of view (homeScore is
 * "us", awayScore is the opponent). Ties are rendered as a neutral "T", never
 * as a loss (audit #56).
 */

import type { TFunction } from 'i18next';

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

/**
 * Spoken form of a season record for an accessibilityLabel, e.g. "Season
 * record: 7 wins, 7 losses, 1 tie". Ties are named only when there are any,
 * matching formatRecord. Colour alone never carries the outcome (#778).
 */
export function describeRecord(t: TFunction, wins: number, losses: number, ties = 0): string {
  const parts = [t('stats.wins', { count: wins }), t('stats.losses', { count: losses })];
  if (ties > 0) parts.push(t('stats.ties', { count: ties }));
  return t('stats.seasonRecordLabel', { record: parts.join(', ') });
}

/**
 * Spoken form of a run of results, in the order given (most recent first on
 * the Stats tab), e.g. "Last 3 games, most recent first: win, tie, loss".
 */
export function describeResults(t: TFunction, results: readonly GameResult[]): string {
  return t('stats.streakLabel', {
    count: results.length,
    results: results.map((result) => t(`stats.result.${result}`)).join(', '),
  });
}
