/**
 * Structured JSON logger with Datadog-compatible attributes.
 *
 * Every line is one JSON object on stdout (stderr for `error`), picked up by
 * the awslogs driver and forwarded to Datadog (`service:bball-tracker-api`).
 *
 * `LOG_LEVEL` (`debug` | `info` | `warn` | `error`, default `info`) is the
 * threshold; it is read on every call so a test can flip it and so the
 * value in `infra/task-definition.json` is the only production switch (#617).
 * An unknown value falls back to `info`. `debug` used to be gated on
 * `NODE_ENV === 'development'`, which made it impossible to turn on for a
 * production diagnosis.
 *
 * Inside an HTTP request the ambient `requestId` and `userId` from
 * `utils/log-context.ts` are merged into every entry; explicit context wins.
 *
 * Never log a name, an email address or a URL with a secret in it: ids only,
 * `hashRecipient()` for addresses, `utils/redact.ts` for URLs.
 */

import { getLogContext } from './log-context';

interface LogContext {
  requestId?: string;
  userId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, value);
}

/** The active threshold: `LOG_LEVEL` lower-cased, or `info` when unset or unknown. */
export function currentLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return isLogLevel(raw) ? raw : DEFAULT_LOG_LEVEL;
}

/** True when a line at `level` passes the configured threshold. */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLogLevel()];
}

function log(level: LogLevel, message: string, context?: LogContext): void {
  if (!isLevelEnabled(level)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: 'bball-tracker-api',
    ...getLogContext(),
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
    log('debug', message, context);
  },
};
