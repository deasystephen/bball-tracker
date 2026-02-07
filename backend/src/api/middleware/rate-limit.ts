/**
 * Rate limiting middleware for sensitive endpoints
 */

import rateLimit from 'express-rate-limit';

/**
 * Strict rate limit for authentication endpoints (login, callback, dev-login)
 * 20 requests per 15 minutes per IP
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
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
