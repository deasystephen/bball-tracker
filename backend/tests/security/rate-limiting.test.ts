/**
 * Security tests for rate limiting middleware
 */

import {
  authRateLimit,
  apiRateLimit,
  inviteAcceptRateLimit,
  exportRateLimit,
  inviteRateLimit,
} from '../../src/api/middleware/rate-limit';

describe('Rate Limiting Configuration', () => {
  it('should export auth rate limit middleware', () => {
    expect(authRateLimit).toBeDefined();
    expect(typeof authRateLimit).toBe('function');
  });

  it('should export API rate limit middleware', () => {
    expect(apiRateLimit).toBeDefined();
    expect(typeof apiRateLimit).toBe('function');
  });

  it('should export invitation accept rate limit middleware (#893)', () => {
    expect(inviteAcceptRateLimit).toBeDefined();
    expect(typeof inviteAcceptRateLimit).toBe('function');
  });

  it('should export the per-user stats export rate limit middleware', () => {
    expect(exportRateLimit).toBeDefined();
    expect(typeof exportRateLimit).toBe('function');
  });

  it('should export the per-user invitation email rate limit middleware (#715)', () => {
    expect(inviteRateLimit).toBeDefined();
    expect(typeof inviteRateLimit).toBe('function');
  });
});

interface WalkLayer {
  handle: { stack?: WalkLayer[] } & unknown;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}

/**
 * Every `METHOD path` mounted anywhere under the API router, with its handler
 * chain. Nested routers (`router.use`) are descended; Express 5 does not keep
 * the mount string on a use-layer, so paths are relative to their own router.
 */
type RouteEntry = { route: string; handlers: unknown[] };

function collectRoutes(stack: WalkLayer[], out: RouteEntry[] = []): RouteEntry[] {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          route: `${method.toUpperCase()} ${layer.route.path}`,
          handlers: layer.route.stack.map((l) => l.handle),
        });
      }
    } else if ((layer.handle as { stack?: WalkLayer[] }).stack) {
      collectRoutes((layer.handle as { stack: WalkLayer[] }).stack, out);
    }
  }
  return out;
}

describe('inviteAcceptRateLimit mount (#893)', () => {
  it('is mounted on the public accept route and on no other write route', async () => {
    const { default: apiRouter } = await import('../../src/api');
    const routes = collectRoutes((apiRouter as unknown as { stack: WalkLayer[] }).stack);
    const writes = routes.filter((r) => /^(POST|PATCH|PUT|DELETE) /.test(r.route));
    expect(writes.length).toBeGreaterThan(30);

    const limited = writes.filter((r) => r.handlers.includes(inviteAcceptRateLimit));
    expect(limited.map((r) => r.route)).toEqual(['POST /by-token/:token/accept']);
  });
});
