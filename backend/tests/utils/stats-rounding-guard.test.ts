/**
 * Guard for #682: stats rounding lives in `shootingPercentage` and `perGame`.
 *
 * `docs/architecture/stats-and-lineage.md` names those two helpers in
 * `src/services/stats-service.ts` as the single place the rounding rule
 * (one decimal, 0 when nothing was attempted / no games) is written. A copy
 * inlined elsewhere in the file would keep the old rule when the helpers
 * change, and one stats endpoint would disagree with another. This suite
 * fails on any `Math.round(` in the file outside the two helper bodies; the
 * season, roster, overall and career aggregations reach them through
 * `derivePlayerAverages`.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../support/source-scan';

const STATS_SERVICE = path.resolve(__dirname, '../../src/services/stats-service.ts');
const HELPERS = ['shootingPercentage', 'perGame'];

/** `source` with the body of each named top-level function removed. */
function withoutFunctions(source: string, names: string[]): string {
  let out = source;
  for (const name of names) {
    const header = new RegExp(`function ${name}\\s*\\([^)]*\\)[^{]*\\{`).exec(out);
    if (!header) throw new Error(`function ${name} not found`);
    let depth = 0;
    let end = header.index + header[0].length - 1;
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}' && --depth === 0) break;
    }
    out = out.slice(0, header.index) + out.slice(end + 1);
  }
  return out;
}

/** Every inlined rounding expression outside the helpers. */
export function findInlinedRounding(source: string): string[] {
  return withoutFunctions(stripComments(source), HELPERS).match(/Math\.round\([^;]*/g) ?? [];
}

describe('stats rounding goes through shootingPercentage / perGame (#682)', () => {
  let source = '';
  beforeAll(() => {
    source = readFileSync(STATS_SERVICE, 'utf8');
  });

  it('the helpers are where the rounding is written', () => {
    // Proof the scan sees real source: removing nothing finds the two helper lines.
    expect(stripComments(source).match(/Math\.round\(/g)).toHaveLength(2);
  });

  it('finds no Math.round outside the helpers', () => {
    expect(findInlinedRounding(source)).toEqual([]);
  });

  it('the four season / career aggregations share derivePlayerAverages', () => {
    expect(source.match(/= derivePlayerAverages\(totals, gamesPlayed\)/g)).toHaveLength(4);
  });
});

describe('the guard pattern', () => {
  const helpers = [
    'export function shootingPercentage(made: number, attempted: number): number {',
    '  return attempted > 0 ? Math.round((made / attempted) * 1000) / 10 : 0;',
    '}',
    'export function perGame(total: number, games: number): number {',
    '  return games > 0 ? Math.round((total / games) * 10) / 10 : 0;',
    '}',
  ].join('\n');

  it('allows the helpers alone', () => {
    expect(findInlinedRounding(helpers)).toEqual([]);
  });

  it.each([
    ['const pct = a > 0 ? Math.round((m / a) * 1000) / 10 : 0;'],
    ['const ppg = g > 0 ? Math.round((pts / g) * 10) / 10 : 0;'],
    ['const pct = Math.round(m / a * 100);'],
  ])('flags %j next to the helpers', (inlined) => {
    expect(findInlinedRounding(`${helpers}\n${inlined}`)).toHaveLength(1);
  });

  it('ignores a commented-out copy', () => {
    expect(findInlinedRounding(`${helpers}\n// const p = Math.round(x * 10) / 10;`)).toEqual([]);
  });
});
