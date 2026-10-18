/**
 * Security tests for rate limiting middleware
 */

import type { Router } from "express";
import {
  authRateLimit,
  apiRateLimit,
  inviteAcceptRateLimit,
  exportRateLimit,
  inviteRateLimit,
} from "../../src/api/middleware/rate-limit";

describe("Rate Limiting Configuration", () => {
  it("should export auth rate limit middleware", () => {
    expect(authRateLimit).toBeDefined();
    expect(typeof authRateLimit).toBe("function");
  });

  it("should export API rate limit middleware", () => {
    expect(apiRateLimit).toBeDefined();
    expect(typeof apiRateLimit).toBe("function");
  });

  it("should export the invitation accept rate limit middleware (#893)", () => {
    expect(inviteAcceptRateLimit).toBeDefined();
    expect(typeof inviteAcceptRateLimit).toBe("function");
  });

  it("should export the per-user stats export rate limit middleware", () => {
    expect(exportRateLimit).toBeDefined();
    expect(typeof exportRateLimit).toBe("function");
  });

  it("should export the per-user invitation email rate limit middleware (#715)", () => {
    expect(inviteRateLimit).toBeDefined();
    expect(typeof inviteRateLimit).toBe("function");
  });
});

/** Every `[METHOD path] -> handlers` pair mounted directly on a router. */
function routeHandlers(router: Router): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const layer of (
    router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: unknown }>;
        };
      }>;
    }
  ).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.set(
        `${method.toUpperCase()} ${layer.route.path}`,
        layer.route.stack.map((l) => l.handle),
      );
    }
  }
  return out;
}

describe("inviteAcceptRateLimit mount (#893)", () => {
  it("is mounted on the public accept route", async () => {
    const { default: publicRouter } =
      await import("../../src/api/invitations/public-routes");
    const routes = routeHandlers(publicRouter);
    expect(routes.get("POST /by-token/:token/accept")).toContain(
      inviteAcceptRateLimit,
    );
  });

  it("is mounted on no authenticated write route, which stay under the global apiRateLimit", async () => {
    const [{ default: invitations }, { default: games }, { default: teams }] =
      await Promise.all([
        import("../../src/api/invitations/routes"),
        import("../../src/api/games/routes"),
        import("../../src/api/teams/routes"),
      ]);
    for (const router of [invitations, games, teams]) {
      for (const [route, handlers] of routeHandlers(router)) {
        if (/^(POST|PATCH|PUT|DELETE) /.test(route)) {
          expect(handlers).not.toContain(inviteAcceptRateLimit);
        }
      }
    }
  });
});
