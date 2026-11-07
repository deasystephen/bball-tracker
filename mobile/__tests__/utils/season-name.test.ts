import { suggestNextSeasonName } from '../../utils/season-name';

describe('suggestNextSeasonName (#461)', () => {
  it.each([
    ['2026', '2027'],
    ['Fall 2026', 'Fall 2027'],
    ['2026 Spring League', '2027 Spring League'],
    ['2026-27', '2027-28'],
    ['2099-00', '2100-01'],
    ['2026/2027', '2027/2028'],
    ['2026–27', '2027–28'],
    ['Fall 2026 - Spring 2027', 'Fall 2027 - Spring 2028'],
    ['Fall 2026 – Spring 2027', 'Fall 2027 – Spring 2028'],
    ['2026 - 27', '2027 - 28'],
    ['2026 – 2027', '2027 – 2028'],
    ['2026 Spring, 2026 Summer', '2027 Spring, 2027 Summer'],
  ])('moves %s forward to %s', (current, next) => {
    expect(suggestNextSeasonName(current)).toBe(next);
  });

  it.each([['Spring'], [''], [null], [undefined], ['U12 Rec']])('suggests nothing for %p', (current) => {
    expect(suggestNextSeasonName(current)).toBe('');
  });
});
