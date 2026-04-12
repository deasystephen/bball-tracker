/**
 * Tests for Sentry PII scrubbing via beforeSend.
 */

import { beforeSend } from '../../src/utils/sentry';
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
