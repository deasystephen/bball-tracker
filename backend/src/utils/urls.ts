import { logger } from './logger';

/**
 * Single source for the two externally visible base URLs.
 *
 *   PUBLIC_APP_URL  — the web apex humans click (invite pages, "View game").
 *                     Production: https://hooplings.com
 *   API_BASE_URL    — the host that actually serves /api/v1/* (calendar feed
 *                     and webcal URLs). Production: https://api.hooplings.com
 *
 * They were conflated once (audit #24) and hardcoded three times with two
 * different fallbacks (domain migration PR2, D10). The fallback is deliberately
 * `http://localhost:3000` for both: a localhost link in a production email is
 * obviously broken, whereas a brand-domain fallback would emit plausible links
 * to the wrong host with nothing in the logs. `warnMissingUrlConfig` makes the
 * misconfiguration loud at boot.
 */
export const DEFAULT_BASE_URL = 'http://localhost:3000';

export const URL_ENV_VARS = ['PUBLIC_APP_URL', 'API_BASE_URL'] as const;
export type UrlEnvVar = (typeof URL_ENV_VARS)[number];

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function readBaseUrl(name: UrlEnvVar, env: NodeJS.ProcessEnv): string {
  const raw = env[name]?.trim();
  return stripTrailingSlash(raw ? raw : DEFAULT_BASE_URL);
}

/** Web apex for human-facing links. No trailing slash. */
export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  return readBaseUrl('PUBLIC_APP_URL', env);
}

/** Host serving /api/v1/*. No trailing slash. */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return readBaseUrl('API_BASE_URL', env);
}

/**
 * Returns the URL env vars that are unset or blank, and logs one warning per
 * missing var when running in production. Called once at server start; tests
 * call it directly with a synthetic env.
 */
export function warnMissingUrlConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<typeof logger, 'warn'> = logger
): UrlEnvVar[] {
  const missing = URL_ENV_VARS.filter((name) => !env[name]?.trim());
  if (env.NODE_ENV === 'production') {
    for (const name of missing) {
      log.warn(`${name} is not set; falling back to ${DEFAULT_BASE_URL} — outbound links will be wrong`, {
        envVar: name,
      });
    }
  }
  return missing;
}
