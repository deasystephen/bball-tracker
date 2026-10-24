// Load environment variables FIRST, before any other imports
import './config/env';

// Initialize Sentry BEFORE importing Express so instrumentation hooks attach.
import { initSentry, sentryErrorHandler, clientErrorStatus } from './utils/sentry';
initSentry();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { setupWebSocketHandlers } from './websocket';
import apiRouter from './api';
import { requestContext } from './api/middleware/request-context';
import { requestLogger, loggablePath } from './api/middleware/request-logger';
import { CLIENT_HEADER, REQUEST_ID_HEADER } from './api/middleware/request-headers';
import { logger } from './utils/logger';
import { warnMissingUrlConfig } from './utils/urls';
import { enforceReplicaGuard } from './utils/replica-guard';
import { assertWorkOSConfig, WorkOSConfigError } from './utils/workos-client';
import { createSesEventConsumer } from './services/mailer/ses-event-consumer';
import { createShutdown } from './utils/shutdown';
import { closeRedis } from './utils/redis';

const app = express();
const httpServer = createServer(app);
// The ALB reuses keep-alive connections to the task for up to its idle timeout
// (60 s, the AWS default; `aws_lb.main` in infra/ecs.tf). Node's default of 5 s
// closes idle connections first, and a request the ALB has already sent on
// such a connection becomes an ELB 502 the app never sees (#749). Keep both
// values strictly above the ALB's, and headersTimeout above keepAliveTimeout.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
// CORS_ORIGIN is a comma-separated list of exact browser origins (scheme + host).
// Always hand cors() the ARRAY: given a plain string the library stamps that value
// on every response regardless of the request Origin, whereas an array reflects the
// request Origin only when it is listed and omits the header otherwise. Passing the
// array even for a single entry keeps the behaviour independent of how many origins
// are configured (#447). Native mobile sends no Origin header and is unaffected.
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:19006').split(',').map(o => o.trim());

// Socket.io currently uses the in-memory adapter. Rooms are local to a single
// process, so broadcasts do NOT fan out across replicas. The GA target is a
// single ECS task; horizontal scale requires `@socket.io/redis-adapter` and a
// shared rate-limit store (tracked in issue #452). `enforceReplicaGuard()`
// (utils/replica-guard.ts) refuses to start the server in production when the
// configured replica ceiling (MAX_REPLICAS) is above 1 — see the call next to
// `httpServer.listen` at the bottom of this file (#446).
const io = new SocketServer(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// Trust the ALB proxy so express-rate-limit reads the real client IP
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
// The browser (the web invite page's accept, #964) may send only these
// request headers; X-Request-Id and X-Hooplings-Client are the correlation
// headers of #963 (api/middleware/request-headers.ts). X-Request-Id is exposed
// so a browser script can read the id the API logged the request under.
app.use(cors({
  origin: corsOrigins,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', REQUEST_ID_HEADER, CLIENT_HEADER],
  exposedHeaders: [REQUEST_ID_HEADER],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request context and logging
app.use(requestContext);
app.use(requestLogger);

// Health check endpoint.
// This backs the ECS container health check, so it pings the database: a
// healthy process that cannot reach the DB is useless (every request 500s), and
// a static 200 here previously let a total DB outage masquerade as "healthy"
// while all sign-ins failed. A failed ping returns 503 (marking the task
// unhealthy so ECS recycles it) and reports to Sentry.
import prisma from './models';
import { captureException } from './utils/sentry';
import { deployedCommit } from './utils/release';
import { isPoolTimeoutError } from './models/pool-config';

// `db` on a failed ping (#751): 'timeout' when pg's connectionTimeoutMillis
// fired (pool saturated, or RDS not answering TCP), 'down' for anything else
// (refused, auth, TLS). Both are 503; the runbook decodes the difference.
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', commit: deployedCommit(), timestamp: new Date().toISOString() });
  } catch (err) {
    const db = isPoolTimeoutError(err) ? 'timeout' : 'down';
    logger.error('Health check DB ping failed', {
      db,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { flow: 'health-check', db });
    res
      .status(503)
      .json({ status: 'degraded', db, commit: deployedCommit(), timestamp: new Date().toISOString() });
  }
});

// Rate limiting
import { apiRateLimit } from './api/middleware/rate-limit';
app.use('/api/v1', apiRateLimit);

// API routes
app.use('/api/v1', apiRouter);

// Setup WebSocket handlers
setupWebSocketHandlers(io);

// Error handling middleware
import { AppError, DetailedError } from './utils/errors';
import { dbBusyOutcome, sendDbBusy } from './utils/db-busy';
import { redactUrlsInText } from './utils/redact';

// Forward exceptions to Sentry before the app's own error handler renders a response.
app.use(sentryErrorHandler);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction): void => {
  // Expected client outcomes (expired token, 403, 404, malformed body) are
  // warnings — reserving `error` for 5xx keeps the error stream meaningful.
  // pg's pool-wait/connect timeout (#751): the pool is saturated or the
  // database is not answering. Answer 503 with Retry-After, not a generic 500.
  // A transaction cancelled waiting on a lock (Prisma P2028 or PostgreSQL
  // lock_timeout, #908) is a 503 `transaction_timeout` whichever service opened
  // it, like a pool timeout: logged at error and captured, because a lock
  // holder that outlasts the wait is a slow-database signal.
  const busy = dbBusyOutcome(err);
  const status = busy ? 503 : err instanceof AppError ? err.statusCode : clientErrorStatus(err);
  const log = status !== undefined && status < 500 ? logger.warn : logger.error;
  log(err.message, {
    requestId: _req.requestId,
    method: _req.method,
    path: loggablePath(_req),
    status,
    // Prisma's own message (configured timeout, elapsed ms) rides on `cause`.
    cause: err.cause instanceof Error ? redactUrlsInText(err.cause.message) : undefined,
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // If it's an AppError, use its status code. A DetailedError also carries a
  // machine-readable `code` and its structured payload (402 upgrade_required,
  // 400 last_head_coach); `body()` is the single serialization rule for those.
  if (busy) {
    sendDbBusy(res, busy);
    return;
  }
  if (err instanceof DetailedError) {
    res.status(err.statusCode).json(err.body());
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  // body-parser / http-errors (malformed JSON → 400, >1 MB body → 413) set a
  // 4xx `status` on a plain Error. Honor it instead of answering 500 (audit #28).
  const clientStatus = clientErrorStatus(err);
  if (clientStatus !== undefined) {
    res.status(clientStatus).json({
      error: clientStatus === 413 ? 'Request body too large' : 'Invalid request body',
    });
    return;
  }

  // Otherwise, return generic 500 - never leak internal error details in production
  res.status(500).json({
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { message: err.message }),
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Only start server if this file is run directly (not when imported)
if (require.main === module) {
  // Exits non-zero before the server listens when the replica ceiling would
  // split live games across tasks (#446). Must stay ahead of `listen`.
  enforceReplicaGuard();
  // The WorkOS client is lazy (the seed imports it without credentials), so the
  // server checks its config here: a task without it must fail its deploy.
  try {
    assertWorkOSConfig();
  } catch (error) {
    if (!(error instanceof WorkOSConfigError)) throw error;
    logger.error('WorkOS config missing', { variable: error.variable });
    process.exit(1);
  }
  warnMissingUrlConfig();
  httpServer.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
  });

  // SES bounce/complaint events (#449). Null — and a no-op — until
  // SES_EVENTS_QUEUE_URL is configured.
  const consumer = createSesEventConsumer();
  consumer?.start();

  // Graceful stop on ECS's SIGTERM (and Ctrl-C locally): utils/shutdown.ts (#747).
  const shutdown = createShutdown({
    io,
    consumer,
    disconnectPrisma: () => prisma.$disconnect(),
    closeRedis,
    exit: (code) => process.exit(code),
  });
  // `on`, not `once`: a second signal must hit the routine's own guard and be
  // ignored. With `once` it would find no listener and Node's default would
  // kill the process mid-shutdown.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

export { app, io, httpServer };

