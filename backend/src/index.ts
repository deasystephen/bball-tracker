// Load environment variables FIRST, before any other imports
import './config/env';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { setupWebSocketHandlers } from './websocket';
import apiRouter from './api';

const app = express();
const httpServer = createServer(app);
// Support multiple origins for mobile (Expo) and web
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:19006').split(',').map(o => o.trim());

const io = new SocketServer(httpServer, {
  cors: {
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    methods: ['GET', 'POST'],
  },
});

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

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction): void => {
  // Log full error for debugging, but only in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Error:', err);
  } else {
    console.error('Error:', err.message);
  }

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
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

export { app, io, httpServer };

