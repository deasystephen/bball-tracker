/**
 * The shared SHOT point rule behind Game.homeScore and the box score (#723).
 */

import { shotMade, shotPoints, shotValue } from '../../src/utils/shot-points';

describe('shot-points', () => {
  it.each([
    [{ made: true, points: 1 }, 1, true, 1],
    [{ made: true, points: 2 }, 2, true, 2],
    [{ made: true, points: 3 }, 3, true, 3],
    [{ made: false, points: 3 }, 3, false, 0],
    [{ made: true }, 2, true, 2],
    [{ made: true, points: 4 }, null, true, 0],
    [{ made: true, points: -5 }, null, true, 0],
    [{ made: true, points: 0 }, null, true, 0],
    [{ made: true, points: 2.5 }, null, true, 0],
    [{ made: true, points: '2' }, null, true, 0],
    [{ made: 'yes', points: 2 }, 2, false, 0],
    [{ made: 1, points: 2 }, 2, false, 0],
    [null, 2, false, 0],
    [[1, 2], 2, false, 0],
    ['shot', 2, false, 0],
  ])('%p → value %p, made %p, points %p', (metadata, value, made, points) => {
    expect(shotValue(metadata)).toBe(value);
    expect(shotMade(metadata)).toBe(made);
    expect(shotPoints(metadata)).toBe(points);
  });

  it('treats undefined metadata as a legacy missed two', () => {
    expect(shotValue(undefined)).toBe(2);
    expect(shotPoints(undefined)).toBe(0);
  });
});
