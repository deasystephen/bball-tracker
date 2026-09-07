/**
 * Config-bound test over the production deploy file (domain migration PR2, D14).
 *
 * `infra/task-definition.json` is the single source of truth for production env
 * (#53). `tests/api/cors.test.ts` already reads CORS_ORIGIN out of it; this suite
 * pins every other domain-bearing value so a half-migrated deploy file fails CI
 * instead of emitting links to the wrong host. Hooplings-only from day one: no
 * browser ever sent a capyhoops Origin (nothing served that host), so there is no
 * transition list to carry (D23).
 */
import { readFileSync } from 'fs';
import path from 'path';

const TASK_DEFINITION_PATH = path.resolve(__dirname, '../../../infra/task-definition.json');
const APEX = 'hooplings.com';
const API_HOST = `api.${APEX}`;
const MAIL_DOMAIN = `mail.${APEX}`;
const RETIRED_DOMAIN = /capyhoops/i;

interface TaskDefinition {
  containerDefinitions: Array<{ environment?: Array<{ name: string; value: string }> }>;
}

function readEnv(): Map<string, string> {
  const td = JSON.parse(readFileSync(TASK_DEFINITION_PATH, 'utf8')) as TaskDefinition;
  return new Map(td.containerDefinitions.flatMap((c) => c.environment ?? []).map((e) => [e.name, e.value]));
}

function host(value: string): string {
  return new URL(value).host;
}

describe('infra/task-definition.json — production domain values', () => {
  const env = readEnv();
  const get = (name: string): string => {
    const value = env.get(name);
    if (value === undefined) throw new Error(`${name} is missing from ${TASK_DEFINITION_PATH}`);
    return value;
  };

  it('PUBLIC_APP_URL is the web apex', () => {
    expect(host(get('PUBLIC_APP_URL'))).toBe(APEX);
    expect(get('PUBLIC_APP_URL')).toMatch(/^https:\/\//);
  });

  it('API_BASE_URL is the API host', () => {
    expect(host(get('API_BASE_URL'))).toBe(API_HOST);
  });

  it('WORKOS_REDIRECT_URI points at the API callback route', () => {
    const url = new URL(get('WORKOS_REDIRECT_URI'));
    expect(url.host).toBe(API_HOST);
    expect(url.pathname).toBe('/api/v1/auth/callback');
  });

  it('SES_FROM_ADDRESS sends from the verified mail subdomain', () => {
    expect(get('SES_FROM_ADDRESS').split('@')[1]).toBe(MAIL_DOMAIN);
  });

  it('CORS_ORIGIN lists the web apex + www and only exact https origins', () => {
    const origins = get('CORS_ORIGIN').split(',').map((o) => o.trim());
    expect(origins).toContain(`https://${APEX}`);
    expect(origins).toContain(`https://www.${APEX}`);
    for (const origin of origins) {
      expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  });

  it('ALLOWED_REDIRECT_SCHEMES lists the current scheme and, until the #504 follow-up, the pre-rename one', () => {
    // Production ran on the code default before #504; now the deploy file is the
    // single home of the overlap. `bball-tracker` stays while any pre-rename
    // TestFlight build can still launch (build #30 expires 2026-11-27) — the
    // follow-up dated 2026-12-01 deletes that entry AND the assertion below.
    const schemes = get('ALLOWED_REDIRECT_SCHEMES').split(',').map((s) => s.trim());
    expect(schemes).toContain('hooplings');
    expect(schemes).toContain('bball-tracker');
    for (const scheme of schemes) {
      // RFC 3986 scheme grammar, lower-case (URL.protocol lower-cases before the compare).
      expect(scheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
    }
  });

  it('no environment value names the retired domain', () => {
    for (const [name, value] of env) {
      expect({ name, value }).not.toMatchObject({ value: expect.stringMatching(RETIRED_DOMAIN) });
    }
  });
});
