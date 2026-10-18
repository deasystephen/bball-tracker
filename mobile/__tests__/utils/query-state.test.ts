import { showQueryError, isTransientLoadError } from '../../utils/query-state';

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

describe('isTransientLoadError', () => {
  const http = (status: number) => ({ response: { status } });

  it('is true for a network failure, 429 and any 5xx', () => {
    expect(isTransientLoadError(new Error('Network Error'))).toBe(true);
    expect(isTransientLoadError(http(429))).toBe(true);
    expect(isTransientLoadError(http(500))).toBe(true);
    expect(isTransientLoadError(http(503))).toBe(true);
  });

  it('is false for 400/404, other client errors and no error', () => {
    expect(isTransientLoadError(http(400))).toBe(false);
    expect(isTransientLoadError(http(404))).toBe(false);
    expect(isTransientLoadError(http(403))).toBe(false);
    expect(isTransientLoadError(null)).toBe(false);
  });
});
