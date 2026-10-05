/**
 * Tests for utils/game-result — W/L/T derivation and the neutral tie colour.
 */

import {
  getGameResult,
  getResultColor,
  formatRecord,
  getRecordParts,
  describeRecord,
  describeResults,
} from '../../utils/game-result';
import { i18n } from '../../i18n';
import { colors } from '../../theme/colors';

describe('getGameResult', () => {
  it('returns W when the tracked team outscores the opponent', () => {
    expect(getGameResult(70, 60)).toBe('W');
  });

  it('returns L when the opponent outscores the tracked team', () => {
    expect(getGameResult(55, 60)).toBe('L');
  });

  it('returns T on equal scores, including 0-0', () => {
    expect(getGameResult(65, 65)).toBe('T');
    expect(getGameResult(0, 0)).toBe('T');
  });
});

describe('getResultColor', () => {
  it.each(['light', 'dark'] as const)('maps W/L/T to success/error/neutral in %s mode', (scheme) => {
    const palette = colors[scheme];
    expect(getResultColor('W', palette)).toBe(palette.success);
    expect(getResultColor('L', palette)).toBe(palette.error);
    expect(getResultColor('T', palette)).toBe(palette.textSecondary);
    expect(getResultColor('T', palette)).not.toBe(palette.error);
  });
});

describe('formatRecord', () => {
  it('omits ties when there are none', () => {
    expect(formatRecord(10, 5)).toBe('10-5');
    expect(formatRecord(10, 5, 0)).toBe('10-5');
  });

  it('includes ties once the team has one', () => {
    expect(formatRecord(10, 5, 1)).toBe('10-5-1');
  });
});

describe('getRecordParts', () => {
  it('lists W and L always and T only once there are ties', () => {
    expect(getRecordParts(3, 2)).toEqual([
      { result: 'W', count: 3 },
      { result: 'L', count: 2 },
    ]);
    expect(getRecordParts(3, 2, 1).map((part) => part.result)).toEqual(['W', 'L', 'T']);
  });
});

// The real translations, so a missing or misnamed plural key in either locale fails here.
const en = i18n.getFixedT('en');
const es = i18n.getFixedT('es');

describe('describeRecord', () => {
  it('reads the record in words, ties only when there are any', () => {
    expect(describeRecord(en, 7, 7, 1)).toBe('Season record: 7 wins, 7 losses, 1 tie');
    expect(describeRecord(en, 1, 1)).toBe('Season record: 1 win, 1 loss');
    expect(describeRecord(en, 0, 2, 2)).toBe('Season record: 0 wins, 2 losses, 2 ties');
  });

  it('reads the Spanish strings', () => {
    expect(describeRecord(es, 1, 2, 1)).toBe('Récord de la temporada: 1 victoria, 2 derrotas, 1 empate');
    expect(describeRecord(es, 2, 1, 2)).toBe('Récord de la temporada: 2 victorias, 1 derrota, 2 empates');
  });
});

describe('describeResults', () => {
  it('reads the results in the order given', () => {
    expect(describeResults(en, ['W', 'T', 'L'])).toBe('Last 3 games, most recent first: win, tie, loss');
    expect(describeResults(en, ['L'])).toBe('Last game: loss');
  });

  it('returns an empty string for an empty run', () => {
    expect(describeResults(en, [])).toBe('');
  });

  it('reads the Spanish strings', () => {
    expect(describeResults(es, ['W', 'T'])).toBe(
      'Últimos 2 partidos, del más reciente al más antiguo: victoria, empate'
    );
    expect(describeResults(es, ['L'])).toBe('Último partido: derrota');
  });
});
