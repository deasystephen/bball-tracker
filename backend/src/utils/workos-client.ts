/**
 * WorkOS client configuration and initialization
 * 
 * NOTE: This module assumes dotenv has been loaded via '../config/env'
 * which should be imported first in index.ts
 */

import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet } from 'jose';

export const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/api/v1/auth/callback';

interface WorkOSConfig {
  client: WorkOS;
  clientId: string;
}

let config: WorkOSConfig | undefined;

/**
 * The WorkOS client and client id, resolved together on first use and then
 * frozen, so the two can never drift. Importing this module (the database seed
 * does, through the websocket emitter) needs no WorkOS environment; the
 * "required" errors are raised here, at call time.
 */
function getWorkOSConfig(): WorkOSConfig {
  if (!config) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) {
      throw new Error('WORKOS_API_KEY environment variable is required');
    }
    const clientId = process.env.WORKOS_CLIENT_ID;
    if (!clientId) {
      throw new Error('WORKOS_CLIENT_ID environment variable is required');
    }
    config = { client: new WorkOS(apiKey), clientId };
  }
  return config;
}

export function getWorkOS(): WorkOS {
  return getWorkOSConfig().client;
}

/** The AuthKit client id. */
export function getWorkOSClientId(): string {
  return getWorkOSConfig().clientId;
}

/**
 * Fail-fast for entry points that need WorkOS (the API server, the
 * data-subject delete script). Throws when either variable is missing.
 */
export function assertWorkOSConfig(): void {
  getWorkOSConfig();
}

/**
 * Issuer expected in WorkOS access tokens. Overridable in case WorkOS changes
 * it per environment; must match the `iss` claim exactly or every request 401s.
 */
export const WORKOS_JWT_ISSUER = process.env.WORKOS_JWT_ISSUER || 'https://api.workos.com';

type Jwks = ReturnType<typeof createRemoteJWKSet>;
let jwks: Jwks | undefined;

/**
 * Lazily-created remote JWKS for this client. `jose` caches keys and refreshes
 * on unknown `kid` (rate-limited by cooldownDuration), so key rotation is
 * handled without a restart.
 */
export function getWorkOSJwks(): Jwks {
  jwks ??= createRemoteJWKSet(new URL(getWorkOSConfig().client.userManagement.getJwksUrl(getWorkOSConfig().clientId)), {
    cooldownDuration: 5 * 60 * 1000,
    cacheMaxAge: 10 * 60 * 1000,
  });
  return jwks;
}
