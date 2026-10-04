/**
 * Rate limiting middleware for sensitive endpoints
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { createHash } from 'crypto';

/**
 * Strict rate limit for authentication endpoints (login, callback, dev-login)
 * 20 requests per 15 minutes per IP in production, relaxed in development for E2E testing
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
});

/**
 * Rate limit for `POST /auth/refresh`.
 *
 * Access tokens are short-lived (~10 min) and every device refreshes
 * independently, so an IP-keyed budget of 20/15 min locks out a team sharing
 * gym Wi-Fi (audit #21). Key on a hash of the refresh token instead — each
 * device rotates its own token — and fall back to the IP only when the body
 * carries no usable token (which the handler rejects with 400 anyway).
 * The ceiling is deliberately generous: a healthy client refreshes ~once per
 * token lifetime, so 60/15 min only trips on a runaway loop or token replay.
 * The mobile client treats a 429 here as transient (keeps its session and
 * retries later) rather than logging the user out.
 */
export const refreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
    if (typeof token === 'string' && token.length > 0) {
      return `rt:${createHash('sha256').update(token).digest('hex')}`;
    }
    return `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  message: { error: 'Too many refresh attempts, please try again later' },
});

/** `GET /invitations/by-token/:token`, relative to the `/api/v1` mount. */
const INVITATION_LOOKUP_RE = /^\/invitations\/by-token\/[^/]+\/?$/;

/**
 * Requests the global IP-keyed limiter does not count (#718): only the public
 * invitation lookup. `hooplings.com/invite/<token>` renders server-side, so
 * every lookup arrives from the web server's egress IP; it has its own
 * token-keyed limiter (`invitationTokenRateLimit`), and an IP budget here
 * would turn a busy minute into "Invitation Not Found" for every visitor.
 * The accept POST stays under the IP limit: the browser calls it directly.
 * `req.path` is relative to the `/api/v1` mount point.
 */
export function skipGlobalApiLimit(req: Request): boolean {
  return req.method === 'GET' && INVITATION_LOOKUP_RE.test(req.path);
}

/**
 * General API rate limit
 * 100 requests per minute per IP (the public invitation lookup is exempt,
 * see `skipGlobalApiLimit`)
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipGlobalApiLimit,
  message: { error: 'Too many requests, please try again later' },
});

/**
 * Write operation rate limit (POST, PATCH, DELETE)
 * 30 requests per minute per IP
 */
export const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests, please try again later' },
});

/**
 * Key for the public invitation-token routes: the token itself, not the IP.
 *
 * `hooplings.com/invite/<token>` is rendered server-side, so every lookup
 * reaches the API from the web server's single egress IP; an IP-keyed limit
 * would start returning 429 ("Invitation Not Found") for everyone after a
 * handful of views (audit #36). Keying on the token still bounds per-token
 * polling, and tokens are 256-bit random so enumeration is not a concern.
 */
export function invitationTokenKey(req: Request): string {
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  return `invite-token:${token}`;
}

/**
 * Rate limit for the unauthenticated invitation lookup, keyed by token.
 * 30 requests per 15 minutes per token (the page is fetched once per view).
 */
export const invitationTokenRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: invitationTokenKey,
  message: { error: 'Too many requests for this invitation, please try again later' },
});

/**
 * Rate limit for the public iCalendar feed endpoint.
 *
 * The feed is token-authenticated via query param (calendar clients can't
 * send Authorization headers), so requests are rate-limited by IP to
 * discourage abuse and token-guessing. Calendar clients typically poll every
 * 15-60 minutes, so 60 requests per hour per IP is generous for legitimate use.
 */
export const calendarFeedRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many calendar feed requests, please try again later' },
});

/**
 * Key for the authenticated export routes: the caller, not the IP.
 *
 * Exports are served to signed-in users only, and a team on shared gym Wi-Fi
 * shares one egress IP, so the budget is per account. The IP is the fallback
 * for the (unreachable) case of no `req.user`.
 */
export function exportUserKey(req: Request): string {
  const userId = req.user?.id;
  if (typeof userId === 'string' && userId.length > 0) {
    return `export-user:${userId}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * Rate limit shared by the three stats export routes (per-game CSV, per-game
 * box-score PDF, team season-stats CSV): 20 exports per minute per user.
 *
 * The PDF is rendered synchronously by PDFKit, so each export spends a few
 * milliseconds of event-loop time on the single API task. No client surfaces
 * these routes yet (issue #50): the only way to run many exports is a
 * signed-in caller looping the URL, and this is the brake on that. A human
 * downloading a season's worth of box scores stays well under the ceiling.
 */
export const exportRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: exportUserKey,
  message: { error: 'Too many export requests, please try again later' },
});

/**
 * Key for the authenticated email-sending roster routes: the caller, not the
 * IP. Same shape as `exportUserKey` with its own prefix, so the two budgets
 * never share a counter.
 */
export function inviteUserKey(req: Request): string {
  const userId = req.user?.id;
  if (typeof userId === 'string' && userId.length > 0) {
    return `invite-user:${userId}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * Rate limit for the routes that can end in an invitation email (#715):
 * `POST /teams/:teamId/invitations` (create and Resend) and
 * `POST /teams/:teamId/players` (unified Add Player, which may also invite a
 * guardian). 60 per hour per user: a coach entering a full roster with
 * guardians in one sitting uses well under half, while a looped Resend from
 * one account is capped at 60 branded emails an hour. The per-recipient
 * resend cooldown in `invitation-service.ts` bounds each address on top.
 * Mounted after `authenticate`, so `req.user` is set.
 */
export const inviteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: inviteUserKey,
  message: { error: 'Too many invitations sent, please try again later' },
});
