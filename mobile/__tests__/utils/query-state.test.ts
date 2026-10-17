import { showQueryError } from '../../utils/query-state';

describe('showQueryError', () => {
  it('is true for a failed query with nothing cached', () => {
    expect(showQueryError({ error: new Error('Network Error'), data: undefined })).toBe(true);
  });

  it('is false when a failed background refetch kept cached data', () => {
    expect(showQueryError({ error: new Error('Network Error'), data: [] })).toBe(false);
    expect(showQueryError({ error: new Error('Network Error'), data: { gamesPlayed: 0 } })).toBe(false);
  });

  it('is false without an error, loaded or not', () => {
    expect(showQueryError({ error: null, data: undefined })).toBe(false);
    expect(showQueryError({ error: null, data: [] })).toBe(false);
  });
});
