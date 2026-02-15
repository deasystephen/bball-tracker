/**
 * Middleware to log every HTTP request on completion
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

const IGNORED_PATHS = ['/health'];

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
      path: req.originalUrl,
      statusCode: res.statusCode,
      duration,
      requestId: req.requestId,
    });
  });

  next();
}
