import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestError } from '../instrumentation';

const TOKEN = 'Zq3x9_K-v7LmN2pR8sT4uW6yA1bC5dE0';

type ErrorRequest = Parameters<typeof onRequestError>[1];
type ErrorContext = Parameters<typeof onRequestError>[2];

const request: ErrorRequest = {
  path: `/invite/${TOKEN}?ref=email`,
  method: 'GET',
  headers: { referer: `https://hooplings.com/invite/${TOKEN}`, cookie: `session=${TOKEN}` },
};

const context: ErrorContext = {
  routerKind: 'App Router',
  routePath: '/invite/[token]',
  routeType: 'render',
  renderSource: 'server-rendering',
  revalidateReason: undefined,
};

describe('instrumentation onRequestError (#966)', () => {
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('logs the route pattern, route type, digest and error name, and nothing from the request path', async () => {
    const error = Object.assign(
      new TypeError(`Failed to parse URL from https://api.hooplings.com/api/v1/invitations/by-token/${TOKEN}`),
      { digest: '2914835163' },
    );

    await onRequestError(error, request, context);

    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0][0]);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('Failed to parse URL');
    expect(line).not.toContain('ref=email');
    expect(JSON.parse(line)).toEqual({
      timestamp: expect.any(String),
      level: 'error',
      message: 'Web request error',
      method: 'GET',
      routePath: '/invite/[token]',
      routeType: 'render',
      routerKind: 'App Router',
      renderSource: 'server-rendering',
      digest: '2914835163',
      errorName: 'TypeError',
      service: 'bball-tracker-web',
      commit: null,
    });
  });

  it('handles a thrown non-Error with no digest', async () => {
    await onRequestError('boom', request, { ...context, renderSource: undefined, routeType: 'route' });

    const entry = JSON.parse(String(err.mock.calls[0][0]));
    expect(entry).toEqual(
      expect.objectContaining({ errorName: 'string', digest: null, renderSource: null, routeType: 'route' })
    );
  });
});
