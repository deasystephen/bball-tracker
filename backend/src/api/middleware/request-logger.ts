/**
 * Middleware to log every HTTP request on completion.
 *
 * Logs the request path plus a *redacted* query string so OAuth codes,
 * calendar tokens and invite tokens never reach CloudWatch / Datadog
 * (audit #15). Secret path segments (`/by-token/<x>`, `/calendar/<x>`,
 * `/invite/<x>`) are masked too.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import { redactPath, redactQueryString } from '../../utils/redact';

const IGNORED_PATHS = ['/health'];

/**
 * Build the loggable path for a request: redacted path + redacted query.
 * Uses the path part of `originalUrl` (so `/api/v1/...` stays intact when a
 * router is mounted) and falls back to `req.path`. Exported for unit tests.
 */
export function loggablePath(req: Pick<Request, 'path' | 'originalUrl'>): string {
  const original = req.originalUrl || '';
  const qIdx = original.indexOf('?');
  const fullPath = qIdx === -1 ? original : original.slice(0, qIdx);
  const path = redactPath(fullPath || req.path);
  const query = qIdx === -1 ? '' : redactQueryString(original.slice(qIdx + 1));
  return query ? `${path}?${query}` : path;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (IGNORED_PATHS.includes(req.path)) {
    next();
    return;
  }

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP request', {
      method: req.method,
      path: loggablePath(req),
      statusCode: res.statusCode,
      duration,
      requestId: req.requestId,
    });
  });

  next();
}
