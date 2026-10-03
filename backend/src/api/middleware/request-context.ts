/**
 * Middleware to set request ID from header or generate one, and to open the
 * per-request log context (`utils/log-context.ts`) that every log line written
 * while this request is handled inherits (#617).
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { runWithLogContext } from '../../utils/log-context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.requestId = requestId;
  runWithLogContext({ requestId }, next);
}
