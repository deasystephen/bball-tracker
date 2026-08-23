/**
 * Rate limiting middleware for sensitive endpoints
 */

import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

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
 * General API rate limit
 * 100 requests per minute per IP
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
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
 * `capyhoops.com/invite/<token>` is rendered server-side, so every lookup
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
