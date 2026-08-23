/**
 * URL / query redaction helpers (audit #15).
 */

import {
  REDACTED,
  isSensitiveQueryKey,
  redactPath,
  redactQueryObject,
  redactQueryString,
  redactUrl,
} from '../../src/utils/redact';

describe('isSensitiveQueryKey', () => {
  it('flags OAuth and token keys', () => {
    for (const k of ['code', 'token', 'state', 'refresh_token', 'accessToken', 'CLIENT_SECRET', 'api_key']) {
      expect(isSensitiveQueryKey(k)).toBe(true);
    }
  });
  it('leaves ordinary keys alone', () => {
    for (const k of ['page', 'limit', 'status', 'seasonId', 'q']) {
      expect(isSensitiveQueryKey(k)).toBe(false);
    }
  });
});

describe('redactQueryString', () => {
  it('keeps keys and masks sensitive values only', () => {
    expect(redactQueryString('code=abc123&state=xyz&page=2')).toBe(
      `code=${REDACTED}&state=${REDACTED}&page=2`
    );
  });
  it('tolerates a leading ? and empty input', () => {
    expect(redactQueryString('?token=t0k')).toBe(`token=${REDACTED}`);
    expect(redactQueryString('')).toBe('');
    expect(redactQueryString(undefined)).toBe('');
  });
  it('handles url-encoded keys and bare flags', () => {
    expect(redactQueryString('refresh%5Ftoken=r&flag')).toBe(`refresh%5Ftoken=${REDACTED}&flag`);
  });
});

describe('redactQueryObject', () => {
  it('masks sensitive values and walks nested objects', () => {
    expect(redactQueryObject({ code: 'c', page: '1', nested: { token: 't', ok: 'y' } })).toEqual({
      code: REDACTED,
      page: '1',
      nested: { token: REDACTED, ok: 'y' },
    });
  });
  it('passes through undefined', () => {
    expect(redactQueryObject(undefined)).toBeUndefined();
  });
});

describe('redactPath', () => {
  it('masks the segment after by-token', () => {
    expect(redactPath('/api/v1/invitations/by-token/abcdef0123456789')).toBe(
      `/api/v1/invitations/by-token/${REDACTED}`
    );
    expect(redactPath('/api/v1/invitations/by-token/abcdef0123456789/accept')).toBe(
      `/api/v1/invitations/by-token/${REDACTED}/accept`
    );
  });
  it('masks calendar and invite tokens', () => {
    expect(redactPath('/api/v1/teams/t1/calendar/0123456789abcdef')).toBe(
      `/api/v1/teams/t1/calendar/${REDACTED}`
    );
    expect(redactPath('/invite/0123456789abcdef')).toBe(`/invite/${REDACTED}`);
  });
  it('does not mask known sub-resources or short segments', () => {
    expect(redactPath('/api/v1/teams/t1/calendar/subscribe')).toBe('/api/v1/teams/t1/calendar/subscribe');
    expect(redactPath('/api/v1/teams/t1/calendar/revoke')).toBe('/api/v1/teams/t1/calendar/revoke');
    expect(redactPath('/api/v1/teams/t1/calendar.ics')).toBe('/api/v1/teams/t1/calendar.ics');
  });
  it('handles empty input', () => {
    expect(redactPath('')).toBe('');
    expect(redactPath(null)).toBe('');
  });
});

describe('redactUrl', () => {
  it('redacts absolute URLs: path segments, query values, drops fragment', () => {
    expect(
      redactUrl('https://api.capyhoops.com/api/v1/invitations/by-token/abcdef0123456789?code=c1&page=3#frag')
    ).toBe(`https://api.capyhoops.com/api/v1/invitations/by-token/${REDACTED}?code=${REDACTED}&page=3`);
  });
  it('redacts path-only URLs', () => {
    expect(redactUrl('/api/v1/auth/callback?code=abc&state=s')).toBe(
      `/api/v1/auth/callback?code=${REDACTED}&state=${REDACTED}`
    );
    expect(redactUrl('/api/v1/teams/t1/calendar.ics?token=tok')).toBe(
      `/api/v1/teams/t1/calendar.ics?token=${REDACTED}`
    );
  });
  it('leaves clean URLs untouched', () => {
    expect(redactUrl('https://api.capyhoops.com/api/v1/games?page=1')).toBe(
      'https://api.capyhoops.com/api/v1/games?page=1'
    );
    expect(redactUrl('')).toBe('');
  });
});
