/**
 * Guard for #682: stats rounding lives in `shootingPercentage` and `perGame`.
 *
 * `docs/architecture/stats-and-lineage.md` names those two helpers in
 * `src/services/stats-service.ts` as the single place the rounding rule
 * (one decimal, 0 when nothing was attempted / no games) is written. A copy
 * inlined elsewhere in the file would keep the old rule when the helpers
 * change, and one stats endpoint would disagree with another. This suite
 * fails on any line in the file holding `Math.round(` other than the two
 * helper bodies (matched verbatim); the season, roster, overall and career
 * aggregations reach them through `derivePlayerAverages`.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../support/source-scan';

const STATS_SERVICE = path.resolve(__dirname, '../../src/services/stats-service.ts');

/** The only two lines in the file allowed to round: the helper bodies, verbatim. */
const HELPER_LINES = [
  'return attempted > 0 ? Math.round((made / attempted) * 1000) / 10 : 0;',
  'return games > 0 ? Math.round((total / games) * 10) / 10 : 0;',
];

/** Every line (trimmed) holding `Math.round(` that is not one of the helper bodies. */
export function findInlinedRounding(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('Math.round(') && !HELPER_LINES.includes(line));
}

describe('stats rounding goes through shootingPercentage / perGame (#682)', () => {
  let source = '';
  beforeAll(() => {
    source = readFileSync(STATS_SERVICE, 'utf8');
  });

  it('rounds exactly twice, in the two helper bodies', () => {
    const lines = stripComments(source)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('Math.round('));
    expect(lines).toEqual(HELPER_LINES);
  });

  it('the helpers are the exported shootingPercentage and perGame', () => {
    expect(source).toContain(
      `export function shootingPercentage(made: number, attempted: number): number {\n  ${HELPER_LINES[0]}\n}`
    );
    expect(source).toContain(`export function perGame(total: number, games: number): number {\n  ${HELPER_LINES[1]}\n}`);
  });

  it('finds no Math.round outside the helpers', () => {
    expect(findInlinedRounding(source)).toEqual([]);
  });

  it('the four season / career aggregations share derivePlayerAverages', () => {
    expect(source.match(/derivePlayerAverages\(totals, gamesPlayed\)/g)).toHaveLength(4);
  });
});

describe('the guard pattern', () => {
  it('allows the helper bodies alone', () => {
    expect(findInlinedRounding(HELPER_LINES.map((line) => `  ${line}`).join('\n'))).toEqual([]);
  });

  it.each([
    ['const pct = a > 0 ? Math.round((m / a) * 1000) / 10 : 0;'],
    ['const ppg = g > 0 ? Math.round((pts / g) * 10) / 10 : 0;'],
    ['const pct = Math.round(m / a * 100);'],
  ])('flags %j', (inlined) => {
    expect(findInlinedRounding(`  ${HELPER_LINES[0]}\n${inlined}`)).toHaveLength(1);
  });

  it('ignores a commented-out copy', () => {
    expect(findInlinedRounding('// const p = Math.round(x * 10) / 10;')).toEqual([]);
  });
});
