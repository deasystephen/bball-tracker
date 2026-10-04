/**
 * Guard: game outcomes are derived only through `utils/game-result.ts` (#673).
 *
 * Ties are a neutral 'T', never a loss (#370). Any screen that compares two
 * scores inline keeps the old rule when `getGameResult` changes, so the
 * outcome drifts between screens. This reads the source and fails on a
 * score-vs-score comparison (`>`, `>=`, `<`, `<=`, `==`, `===`, `!=`, `!==`)
 * or a score difference (`homeScore - awayScore`) anywhere outside the helper.
 *
 * Both shapes need a score identifier on BOTH sides, so input guards such as
 * `opponentScore <= 0` in the tracker are not outcome derivations and pass.
 *
 * To fix a finding, use `getGameResult(home, away) === 'W'` (or 'L' / 'T').
 */

import fs from 'fs';
import path from 'path';

import { MOBILE_ROOT, scanLines, sourceFiles } from '../helpers/source-files';

const SCANNED_DIRS = ['app', 'components', 'hooks', 'store', 'utils'];
const ALLOWED = new Set([path.join('utils', 'game-result.ts')]);

const SCORE = '(?:homeScore|awayScore|opponentScore)';
const OPERAND = `(?:\\w+\\.)?${SCORE}`;
const COMPARATOR = '(?:===?|!==?|>=?|<=?)';
const INLINE_OUTCOME = new RegExp(`\\b${SCORE}\\s*(?:${COMPARATOR}|-)\\s*${OPERAND}\\b`);

export function findInlineOutcomes(fileName: string, text: string): string[] {
  return scanLines(fileName, text, INLINE_OUTCOME);
}

describe('game outcomes are derived through utils/game-result.ts', () => {
  it('finds no inline score comparison in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx']));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const findings = files
      .map((file) => path.relative(MOBILE_ROOT, file))
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => findInlineOutcomes(file, fs.readFileSync(path.join(MOBILE_ROOT, file), 'utf8')));

    expect(findings).toEqual([]);
  });

  describe('the scanner', () => {
    it.each([
      'recentGames.filter((g) => g.homeScore > g.awayScore).length',
      'if (homeScore > opponentScore) {',
      'const lost = game.awayScore >= game.homeScore;',
      'homeScore<awayScore',
      'const tied = game.homeScore === game.awayScore;',
      'if (homeScore == awayScore) {',
      'const decided = homeScore !== opponentScore;',
      'game.homeScore != game.awayScore',
      'const won = game.homeScore - game.awayScore > 0;',
      'const margin = awayScore - homeScore;',
    ])('reports %s', (line) => {
      expect(findInlineOutcomes('sample.tsx', line)).toHaveLength(1);
    });

    it.each([
      "getGameResult(g.homeScore, g.awayScore) === 'W'",
      'if (opponentScore <= 0) return;',
      'const total = homeScore + awayScore;',
      'homeScore > 0 && awayScore > 0',
      'if (homeScore === 0) return;',
      'const next = homeScore - 1;',
    ])('accepts %s', (line) => {
      expect(findInlineOutcomes('sample.tsx', line)).toEqual([]);
    });
  });
});
