/**
 * Guard: game outcomes are derived only through `utils/game-result.ts` (#673).
 *
 * Ties are a neutral 'T', never a loss (#370). Any screen that compares two
 * scores inline keeps the old rule when `getGameResult` changes, so the
 * outcome drifts between screens. This reads the source and fails on a
 * score-vs-score comparison anywhere outside the helper.
 *
 * The pattern needs a score identifier on BOTH sides, so input guards such as
 * `opponentScore <= 0` in the tracker are not outcome derivations and pass.
 *
 * To fix a finding, use `getGameResult(home, away) === 'W'` (or 'L' / 'T').
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const SCANNED_DIRS = ['app', 'components', 'hooks', 'store', 'utils'];
const ALLOWED = new Set([path.join('utils', 'game-result.ts')]);

const SCORE = '(?:homeScore|awayScore|opponentScore)';
const INLINE_OUTCOME = new RegExp(`\\b${SCORE}\\s*(?:>=?|<=?)\\s*(?:\\w+\\.)?${SCORE}\\b`);

export function findInlineOutcomes(fileName: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, index) => (INLINE_OUTCOME.test(line) ? [`${fileName}:${index + 1} ${line.trim()}`] : []));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('game outcomes are derived through utils/game-result.ts', () => {
  it('finds no inline score comparison in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir)));
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
    ])('reports %s', (line) => {
      expect(findInlineOutcomes('sample.tsx', line)).toHaveLength(1);
    });

    it.each([
      "getGameResult(g.homeScore, g.awayScore) === 'W'",
      'if (opponentScore <= 0) return;',
      'const total = homeScore + awayScore;',
      'homeScore > 0 && awayScore > 0',
    ])('accepts %s', (line) => {
      expect(findInlineOutcomes('sample.tsx', line)).toEqual([]);
    });
  });
});
