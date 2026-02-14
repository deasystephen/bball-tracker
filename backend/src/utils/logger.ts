/**
 * Structured JSON logger with Datadog-compatible attributes
 */

interface LogContext {
  requestId?: string;
  userId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
  [key: string]: unknown;
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: 'bball-tracker-api',
    ...context,
  };

  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  info: (message: string, context?: LogContext): void => {
    log('info', message, context);
  },
  warn: (message: string, context?: LogContext): void => {
    log('warn', message, context);
  },
  error: (message: string, context?: LogContext): void => {
    log('error', message, context);
  },
  debug: (message: string, context?: LogContext): void => {
    if (process.env.NODE_ENV === 'development') {
      log('debug', message, context);
    }
  },
};
