/**
 * WorkOS client configuration and initialization
 * 
 * NOTE: This module assumes dotenv has been loaded via '../config/env'
 * which should be imported first in index.ts
 */

import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet } from 'jose';

let client: WorkOS | undefined;

/**
 * The WorkOS client, constructed on first use so that importing this module
 * (the database seed does, through the websocket emitter) needs no WorkOS
 * environment. The "required" error is raised at call time.
 */
export function getWorkOS(): WorkOS {
  if (!client) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) {
      throw new Error('WORKOS_API_KEY environment variable is required');
    }
    client = new WorkOS(apiKey, {
      apiHostname: 'api.workos.com', // Production and sandbox share the hostname
    });
  }
  return client;
}

export const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/api/v1/auth/callback';

/** The AuthKit client id; read at call time, throws when unset. */
export function getWorkOSClientId(): string {
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    throw new Error('WORKOS_CLIENT_ID environment variable is required');
  }
  return clientId;
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
  jwks ??= createRemoteJWKSet(new URL(getWorkOS().userManagement.getJwksUrl(getWorkOSClientId())), {
    cooldownDuration: 5 * 60 * 1000,
    cacheMaxAge: 10 * 60 * 1000,
  });
  return jwks;
}
