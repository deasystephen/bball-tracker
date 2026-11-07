import { isSeasonAfter } from '../../utils/season-order';

describe('isSeasonAfter (#461 rollover picker, mirrors the API)', () => {
  it('requires a strictly later start when both seasons are dated', () => {
    expect(isSeasonAfter({ startDate: '2027-01-01' }, { startDate: '2026-01-01' })).toBe(true);
    expect(isSeasonAfter({ startDate: '2026-01-01' }, { startDate: '2026-01-01' })).toBe(false);
    expect(isSeasonAfter({ startDate: '2025-01-01' }, { startDate: '2026-01-01' })).toBe(false);
  });

  it('allows it when either season has no start date (nothing to order by)', () => {
    // A dated season followed by an undated later one.
    expect(isSeasonAfter({ startDate: null }, { startDate: '2030-01-01' })).toBe(true);
    expect(isSeasonAfter({}, { startDate: '2030-01-01' })).toBe(true);
    expect(isSeasonAfter({ startDate: '2020-01-01' }, { startDate: null })).toBe(true);
    expect(isSeasonAfter({ startDate: 'not a date' }, { startDate: '2030-01-01' })).toBe(true);
  });
});
