import { isSeasonAfter } from '../../utils/season-order';

describe('isSeasonAfter (#461 rollover picker, mirrors the API)', () => {
  it('orders by start date when both seasons have one', () => {
    expect(isSeasonAfter({ startDate: '2027-01-01', createdAt: '2020-01-01' }, { startDate: '2026-01-01', createdAt: '2030-01-01' })).toBe(true);
    expect(isSeasonAfter({ startDate: '2025-01-01', createdAt: '2030-01-01' }, { startDate: '2026-01-01', createdAt: '2020-01-01' })).toBe(false);
  });

  it('treats an equal start as not after', () => {
    expect(isSeasonAfter({ startDate: '2026-01-01', createdAt: '2030-01-01' }, { startDate: '2026-01-01', createdAt: '2020-01-01' })).toBe(false);
  });

  it('falls back to creation time when either has no start date', () => {
    expect(isSeasonAfter({ startDate: null, createdAt: '2027-01-01' }, { startDate: '2030-01-01', createdAt: '2026-01-01' })).toBe(true);
    expect(isSeasonAfter({ startDate: '2030-01-01', createdAt: '2025-01-01' }, { startDate: null, createdAt: '2026-01-01' })).toBe(false);
  });

  it('leaves a season out when it cannot be ordered', () => {
    expect(isSeasonAfter({}, { createdAt: '2026-01-01' })).toBe(false);
    expect(isSeasonAfter({ createdAt: '2027-01-01' }, {})).toBe(false);
  });
});
