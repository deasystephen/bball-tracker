/**
 * App logging (#617).
 *
 * `log.debug` / `log.info` print to the Metro console in development builds
 * and are no-ops in release builds. `log.warn` / `log.error` also leave a
 * Sentry breadcrumb, so the trail before a captured exception is readable in
 * production, where nobody sees the console.
 *
 * This module imports nothing: `services/sentry.ts` and
 * `services/analytics.ts` log through it during their own initialization,
 * so it cannot depend on either. Sentry plugs in the breadcrumb sink once it
 * has initialized (`setLogBreadcrumbSink`); until then warn/error are
 * console-only, which is also what a dev build without a DSN wants.
 *
 * Bare `console.*` is forbidden everywhere else in app code (ESLint
 * `no-console`); this file is the one place it is allowed. Never log a token,
 * an email address or a raw URL: pass ids and the redacted endpoint pattern.
 */

export type LogData = Record<string, unknown>;

export type LogBreadcrumbLevel = 'warning' | 'error';

export type LogBreadcrumbSink = (level: LogBreadcrumbLevel, message: string, data?: LogData) => void;

let breadcrumbSink: LogBreadcrumbSink | null = null;

/** Install (or remove, with `null`) the breadcrumb sink for warn/error. */
export function setLogBreadcrumbSink(sink: LogBreadcrumbSink | null): void {
  breadcrumbSink = sink;
}

/**
 * Breadcrumb data must be plain JSON: an `Error` is reduced to its name and
 * message (a stack is noise in a breadcrumb and may carry a URL).
 */
export function toBreadcrumbData(data: LogData | undefined): LogData | undefined {
  if (!data) return undefined;
  const out: LogData = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return out;
}

function devConsole(method: 'log' | 'info' | 'warn' | 'error', message: string, data?: LogData): void {
  if (!__DEV__) return;
  if (data === undefined) {
    console[method](message);
  } else {
    console[method](message, data);
  }
}

function crumb(level: LogBreadcrumbLevel, message: string, data?: LogData): void {
  if (!breadcrumbSink) return;
  try {
    breadcrumbSink(level, message, toBreadcrumbData(data));
  } catch {
    // Logging must never throw into the caller.
  }
}

export const log = {
  /** Development-only console output. */
  debug(message: string, data?: LogData): void {
    devConsole('log', message, data);
  },
  /** Development-only console output. */
  info(message: string, data?: LogData): void {
    devConsole('info', message, data);
  },
  /** Console in development, plus a Sentry breadcrumb when Sentry is up. */
  warn(message: string, data?: LogData): void {
    devConsole('warn', message, data);
    crumb('warning', message, data);
  },
  /** Console in development, plus a Sentry breadcrumb when Sentry is up. */
  error(message: string, data?: LogData): void {
    devConsole('error', message, data);
    crumb('error', message, data);
  },
};
