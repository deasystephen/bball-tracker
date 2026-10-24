/**
 * The web server's structured logger (#966). One JSON object per line on
 * stdout (stderr for `error`), the shape the API writes
 * (`backend/src/utils/logger.ts`):
 *
 *   { timestamp, level, message, ...context, service: 'bball-tracker-web', commit }
 *
 * The awslogs driver ships the lines to `/ecs/bball-tracker-production-web`, and
 * `infra/datadog.tf` forwards to Datadog only the lines whose `service` is
 * `bball-tracker-web`, so only what this logger writes leaves CloudWatch.
 * Next.js's own free-text output stays there.
 *
 * Invitation links carry bearer tokens in their path, so every string this
 * logger prints (the message and each context value) goes through
 * `redactText`: the segment after `/invite/`, `/by-token/` or `/calendar/` and
 * secret-looking query values become `[redacted]`, and a context key that
 * names a secret is masked whole. Context is meant for ids, enums and statuses
 * only; its type admits no objects, so an `Error` (whose message may quote a
 * URL) cannot be passed as is. Log `error.name`, never the error.
 *
 * This is the only file in `web/` allowed to call `console` (ESLint
 * `no-console`, `eslint.config.mjs`).
 */

export const LOG_SERVICE = 'bball-tracker-web';

export const REDACTED = '[redacted]';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogValue = string | number | boolean | null | undefined;

export type LogContext = Record<string, LogValue>;

/** A full commit id, as CI writes `GIT_COMMIT` into the task definition; anything else is `null`. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function deployedCommit(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.GIT_COMMIT?.trim();
  return raw !== undefined && COMMIT_PATTERN.test(raw) ? raw : null;
}

/**
 * The path segment after one of these is a bearer secret. A segment in
 * brackets is a route pattern (`/invite/[token]`), not a value, and is kept.
 */
const SECRET_SEGMENT = /(\/(?:invite|by-token|calendar)\/)(?!\[[^\]/]*\](?:[/?#\s'"]|$))[^/?#\s'"<>()]+/gi;

/** Query keys whose value is masked: any key containing one of these words. */
const SECRET_QUERY = /([?&][^=&#\s'"]*(?:token|secret|password|code|state|jwt|key)[^=&#\s'"]*=)[^&#\s'"<>()]*/gi;

/**
 * Context keys that are masked whole, whatever the value: anything naming a
 * token, secret, password, credential or key, and the OAuth `code` / `state`.
 */
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|jwt|credential|key|^code$|^state$/i;

/** Mask invitation and calendar tokens and secret query values inside any text. */
export function redactText(text: string): string {
  return text.replace(SECRET_SEGMENT, `$1${REDACTED}`).replace(SECRET_QUERY, `$1${REDACTED}`);
}

function redactContext(context: LogContext | undefined): LogContext {
  const out: LogContext = {};
  if (!context) return out;
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = typeof value === 'string' ? redactText(value) : value;
    }
  }
  return out;
}

/** Build the entry a line prints. Exported for tests; production code calls `log.*`. */
export function buildEntry(level: LogLevel, message: string, context?: LogContext): Record<string, LogValue> {
  // The fixed fields lead the line and are written again after the context, so
  // no context key can overwrite them (a context `level` would hide an error).
  const fixed = { timestamp: new Date().toISOString(), level, message: redactText(message) };
  return Object.assign({ ...fixed }, redactContext(context), fixed, {
    service: LOG_SERVICE,
    commit: deployedCommit(),
  });
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  const line = JSON.stringify(buildEntry(level, message, context));
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (message: string, context?: LogContext): void => write('info', message, context),
  warn: (message: string, context?: LogContext): void => write('warn', message, context),
  error: (message: string, context?: LogContext): void => write('error', message, context),
};
