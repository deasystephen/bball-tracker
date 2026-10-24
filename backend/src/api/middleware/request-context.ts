/**
 * Middleware to set the request id and the client identifier from their
 * headers (validated, `request-headers.ts`, #963), and to open the per-request
 * log context (`utils/log-context.ts`) that every log line written while this
 * request is handled inherits (#617).
 *
 * The request id used, the client's or a generated one, is echoed on every
 * response as `X-Request-Id`.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { runWithLogContext, type LogContextStore } from '../../utils/log-context';
import { REQUEST_ID_HEADER, parseClientHeader, parseRequestIdHeader } from './request-headers';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      /** The validated `X-Hooplings-Client` value; logged, never trusted for auth. */
      hooplingsClient?: string;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = parseRequestIdHeader(req.headers['x-request-id']) ?? crypto.randomUUID();
  const client = parseClientHeader(req.headers['x-hooplings-client']);
  req.requestId = requestId;
  req.hooplingsClient = client;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const store: LogContextStore = client ? { requestId, client } : { requestId };
  runWithLogContext(store, next);
}
