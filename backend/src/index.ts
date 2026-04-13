// Load environment variables FIRST, before any other imports
import './config/env';

// Initialize Sentry BEFORE importing Express so instrumentation hooks attach.
import { initSentry, sentryErrorHandler } from './utils/sentry';
initSentry();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { setupWebSocketHandlers } from './websocket';
import apiRouter from './api';
import { requestContext } from './api/middleware/request-context';
import { requestLogger } from './api/middleware/request-logger';
import { logger } from './utils/logger';

const app = express();
const httpServer = createServer(app);
// Support multiple origins for mobile (Expo) and web
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:19006').split(',').map(o => o.trim());

// Socket.io currently uses the in-memory adapter. Rooms are local to a single
// process, so broadcasts do NOT fan out across replicas. The GA target is a
// single ECS task; horizontal scale requires `@socket.io/redis-adapter`
// (tracked in issue #26). The startup guard below logs loudly if we boot in
// production without a Redis adapter URL configured.
const io = new SocketServer(httpServer, {
  cors: {
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    methods: ['GET', 'POST'],
  },
});

if (
  process.env.NODE_ENV === 'production' &&
  !process.env.REDIS_SOCKET_ADAPTER_URL
) {
  logger.error(
    'FATAL-WARN: Socket.io running without Redis adapter in production. ' +
      'Live game broadcasts will only reach clients connected to the SAME ' +
      'backend replica. This is safe only when running a SINGLE ECS task. ' +
      'Set REDIS_SOCKET_ADAPTER_URL and wire up @socket.io/redis-adapter ' +
      'before scaling >1 replica. (issue #26)'
  );
}

const PORT = process.env.PORT || 3000;

// Trust the ALB proxy so express-rate-limit reads the real client IP
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors({
  origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request context and logging
app.use(requestContext);
app.use(requestLogger);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rate limiting
import { apiRateLimit } from './api/middleware/rate-limit';
app.use('/api/v1', apiRateLimit);

// API routes
app.use('/api/v1', apiRouter);

// Setup WebSocket handlers
setupWebSocketHandlers(io);

// Error handling middleware
import { AppError } from './utils/errors';

// Forward exceptions to Sentry before the app's own error handler renders a response.
app.use(sentryErrorHandler);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction): void => {
  logger.error(err.message, {
    requestId: _req.requestId,
    method: _req.method,
    path: _req.originalUrl,
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // If it's an AppError, use its status code
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
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
  httpServer.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV || 'development' });
  });
}

export { app, io, httpServer };

