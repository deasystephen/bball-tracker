/**
 * Tests for utils/game-result — W/L/T derivation and the neutral tie colour.
 */

import { getGameResult, getResultColor, formatRecord } from '../../utils/game-result';
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
