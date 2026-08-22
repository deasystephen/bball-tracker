/**
 * Tests for Sentry PII scrubbing via beforeSend.
 */

import { beforeSend, isExpectedClientError } from '../../src/utils/sentry';
import { AppError, NotFoundError, UnauthorizedError } from '../../src/utils/errors';
import type { Event } from '@sentry/node';

describe('sentry beforeSend', () => {
  it('scrubs authorization and cookie headers from the request', () => {
    const event: Event = {
      request: {
        url: 'https://api.capyhoops.com/api/v1/games',
        method: 'POST',
        headers: {
          authorization: 'Bearer eyJhbGciOi...',
          Cookie: 'session=abc123',
          'X-Api-Key': 'sk_live_xxx',
          'User-Agent': 'mobile/1.0',
        },
        cookies: { session: 'abc123' },
        data: { email: 'foo@bar.com', password: 'hunter2', note: 'hi' },
      },
    };

    const out = beforeSend(event);

    expect(out).not.toBeNull();
    const headers = out!.request!.headers as Record<string, string>;
    expect(headers.authorization).toBe('[scrubbed]');
    expect(headers.Cookie).toBe('[scrubbed]');
    expect(headers['X-Api-Key']).toBe('[scrubbed]');
    // Non-sensitive header preserved
    expect(headers['User-Agent']).toBe('mobile/1.0');
    // Cookies object scrubbed
    expect((out!.request!.cookies as Record<string, string>).session).toBe('[scrubbed]');
    // Body dropped wholesale
    expect(out!.request!.data).toBe('[scrubbed]');
  });

  it('scrubs sensitive keys in event.extra recursively', () => {
    const event: Event = {
      extra: {
        userId: 'user_123',
        context: {
          password: 'secret',
          refresh_token: 'rt_xxx',
          benign: 'ok',
        },
      },
    };

    const out = beforeSend(event);
    const ctx = out!.extra!.context as Record<string, string>;
    expect(ctx.password).toBe('[scrubbed]');
    expect(ctx.refresh_token).toBe('[scrubbed]');
    expect(ctx.benign).toBe('ok');
    expect(out!.extra!.userId).toBe('user_123');
  });

  it('scrubs breadcrumb data', () => {
    const event: Event = {
      breadcrumbs: [
        {
          message: 'request',
          data: { authorization: 'Bearer x', path: '/x' },
        },
      ],
    };
    const out = beforeSend(event);
    const data = out!.breadcrumbs![0].data as Record<string, string>;
    expect(data.authorization).toBe('[scrubbed]');
    expect(data.path).toBe('/x');
  });

  it('returns the event unchanged when no sensitive data present', () => {
    const event: Event = { message: 'hello' };
    expect(beforeSend(event)).toEqual({ message: 'hello' });
  });
});

describe('isExpectedClientError', () => {
  // Regression (#349): an expired bearer token produced a Sentry error on every
  // request. Operational 4xx AppErrors are expected client outcomes, not defects.
  it('treats operational 4xx AppErrors as expected', () => {
    expect(isExpectedClientError(new UnauthorizedError('Invalid or expired token'))).toBe(true);
    expect(isExpectedClientError(new NotFoundError())).toBe(true);
    expect(isExpectedClientError(new AppError('nope', 400))).toBe(true);
  });

  it('still reports 5xx AppErrors, non-operational errors, and plain Errors', () => {
    expect(isExpectedClientError(new AppError('boom', 500))).toBe(false);
    expect(isExpectedClientError(new AppError('boom', 400, false))).toBe(false);
    expect(isExpectedClientError(new Error('boom'))).toBe(false);
    expect(isExpectedClientError('string')).toBe(false);
  });
});
