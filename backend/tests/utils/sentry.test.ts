/**
 * Tests for Sentry PII scrubbing via beforeSend.
 */

import * as SentryNode from '@sentry/node';
import {
  beforeSend,
  beforeSendTransaction,
  clientErrorStatus,
  initSentry,
  isExpectedClientError,
  sentryErrorHandler,
  type TransactionEvent,
} from '../../src/utils/sentry';
import { AppError, NotFoundError, UnauthorizedError } from '../../src/utils/errors';
import type { Event } from '@sentry/node';
import type { Request, Response } from 'express';

jest.mock('@sentry/node', () => {
  const scope = { setUser: jest.fn(), setTag: jest.fn(), setTags: jest.fn() };
  return {
    init: jest.fn(),
    withScope: jest.fn((cb: (s: typeof scope) => void) => cb(scope)),
    captureException: jest.fn(),
    __scope: scope,
  };
});

const mockCapture = SentryNode.captureException as jest.Mock;

function bodyParserError(status: number, type: string): Error {
  return Object.assign(new Error(type), { status, statusCode: status, type, expose: true });
}

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

  // Audit #15: request.url and query_string carried OAuth codes and tokens.
  it('redacts request.url query values and by-token path segments', () => {
    const event: Event = {
      request: {
        url: 'https://api.capyhoops.com/api/v1/invitations/by-token/abcdef0123456789?code=OAUTHCODE&page=1',
        query_string: 'code=OAUTHCODE&state=ST&page=1',
      },
      transaction: 'GET /api/v1/teams/t1/calendar.ics?token=CALTOKEN',
    };
    const out = beforeSend(event);
    expect(out.request!.url).toBe(
      'https://api.capyhoops.com/api/v1/invitations/by-token/[redacted]?code=[redacted]&page=1'
    );
    expect(out.request!.query_string).toBe('code=[redacted]&state=[redacted]&page=1');
    expect(out.transaction).toBe('GET /api/v1/teams/t1/calendar.ics?token=[redacted]');
    expect(JSON.stringify(out)).not.toMatch(/OAUTHCODE|CALTOKEN|abcdef0123456789/);
  });

  it('redacts object-shaped query_string values', () => {
    const event: Event = { request: { query_string: { code: 'OAUTHCODE', page: '1' } } };
    const out = beforeSend(event);
    expect(out.request!.query_string).toEqual({ code: '[redacted]', page: '1' });
  });

  it('redacts breadcrumb data.url by value, not just by key name', () => {
    const event: Event = {
      breadcrumbs: [{ category: 'http', data: { url: '/api/v1/auth/callback?code=OAUTHCODE', method: 'GET' } }],
    };
    const out = beforeSend(event);
    expect(out.breadcrumbs![0].data!.url).toBe('/api/v1/auth/callback?code=[redacted]');
    expect(out.breadcrumbs![0].data!.method).toBe('GET');
  });
});

describe('sentry beforeSendTransaction', () => {
  it('redacts transaction name, request.url, trace data and span urls', () => {
    const event: TransactionEvent = {
      type: 'transaction',
      transaction: 'GET /api/v1/invitations/by-token/abcdef0123456789',
      request: { url: 'https://api.capyhoops.com/api/v1/auth/callback?code=OAUTHCODE' },
      contexts: {
        trace: {
          span_id: 's',
          trace_id: 't',
          data: { 'http.url': 'https://api.capyhoops.com/api/v1/auth/callback?code=OAUTHCODE', 'http.method': 'GET' },
        },
      },
      spans: [
        {
          span_id: 's2',
          trace_id: 't',
          start_timestamp: 0,
          description: 'GET /api/v1/teams/t1/calendar.ics?token=CALTOKEN',
          data: { url: '/api/v1/teams/t1/calendar.ics?token=CALTOKEN' },
        },
      ],
    };
    const out = beforeSendTransaction(event);
    expect(out.transaction).toBe('GET /api/v1/invitations/by-token/[redacted]');
    expect(out.request!.url).toBe('https://api.capyhoops.com/api/v1/auth/callback?code=[redacted]');
    expect(out.contexts!.trace!.data!['http.url']).toBe(
      'https://api.capyhoops.com/api/v1/auth/callback?code=[redacted]'
    );
    expect(out.contexts!.trace!.data!['http.method']).toBe('GET');
    expect(out.spans![0].description).toBe('GET /api/v1/teams/t1/calendar.ics?token=[redacted]');
    expect(out.spans![0].data!.url).toBe('/api/v1/teams/t1/calendar.ics?token=[redacted]');
    expect(JSON.stringify(out)).not.toMatch(/OAUTHCODE|CALTOKEN|abcdef0123456789/);
  });

  it('passes through an event with nothing to redact', () => {
    const event: TransactionEvent = { type: 'transaction', transaction: 'GET /api/v1/games' };
    expect(beforeSendTransaction(event)).toEqual(event);
  });
});

describe('clientErrorStatus', () => {
  it('returns 4xx statuses from body-parser style errors', () => {
    expect(clientErrorStatus(bodyParserError(400, 'entity.parse.failed'))).toBe(400);
    expect(clientErrorStatus(bodyParserError(413, 'entity.too.large'))).toBe(413);
    expect(clientErrorStatus(Object.assign(new Error('x'), { statusCode: 415 }))).toBe(415);
  });
  it('ignores non-4xx, non-numeric and non-object inputs', () => {
    expect(clientErrorStatus(Object.assign(new Error('x'), { status: 500 }))).toBeUndefined();
    expect(clientErrorStatus(Object.assign(new Error('x'), { status: '400' }))).toBeUndefined();
    expect(clientErrorStatus(new Error('x'))).toBeUndefined();
    expect(clientErrorStatus(null)).toBeUndefined();
    expect(clientErrorStatus('400')).toBeUndefined();
  });
});

describe('sentryErrorHandler', () => {
  const req = { method: 'POST', originalUrl: '/api/v1/teams?code=OAUTHCODE', requestId: 'r1' } as unknown as Request;
  const res = {} as Response;

  beforeAll(() => {
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    initSentry();
  });
  afterAll(() => {
    delete process.env.SENTRY_DSN;
  });
  beforeEach(() => {
    mockCapture.mockClear();
  });

  // Audit #28: body-parser 4xx errors were captured as unhandled 500s.
  it('does not capture body-parser 400/413 errors but still calls next', () => {
    const next = jest.fn();
    const err = bodyParserError(400, 'entity.parse.failed');
    sentryErrorHandler(err, req, res, next);
    sentryErrorHandler(bodyParserError(413, 'entity.too.large'), req, res, next);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('still captures plain errors, tagging a redacted route', () => {
    const next = jest.fn();
    const err = new Error('boom');
    sentryErrorHandler(err, req, res, next);
    expect(mockCapture).toHaveBeenCalledWith(err);
    const scope = (SentryNode as unknown as { __scope: { setTag: jest.Mock } }).__scope;
    expect(scope.setTag).toHaveBeenCalledWith('route', '/api/v1/teams?code=[redacted]');
    expect(next).toHaveBeenCalledWith(err);
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

  // Audit #28: body-parser errors carry a 4xx `status` on a non-AppError.
  it('treats non-AppError errors with a 4xx status as expected', () => {
    expect(isExpectedClientError(bodyParserError(400, 'entity.parse.failed'))).toBe(true);
    expect(isExpectedClientError(bodyParserError(413, 'entity.too.large'))).toBe(true);
    expect(isExpectedClientError(Object.assign(new Error('x'), { status: 502 }))).toBe(false);
  });
});
