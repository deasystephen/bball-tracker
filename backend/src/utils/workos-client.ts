/**
 * WorkOS client configuration and initialization
 * 
 * NOTE: This module assumes dotenv has been loaded via '../config/env'
 * which should be imported first in index.ts
 */

import { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet } from 'jose';

if (!process.env.WORKOS_API_KEY) {
  throw new Error('WORKOS_API_KEY environment variable is required');
}

export const workos = new WorkOS(process.env.WORKOS_API_KEY, {
  apiHostname: process.env.WORKOS_ENVIRONMENT === 'production' 
    ? 'api.workos.com' 
    : 'api.workos.com', // Sandbox uses same hostname
});

const WORKOS_CLIENT_ID_ENV = process.env.WORKOS_CLIENT_ID;
export const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/api/v1/auth/callback';

if (!WORKOS_CLIENT_ID_ENV) {
  throw new Error('WORKOS_CLIENT_ID environment variable is required');
}

// After the check, we know it's defined
export const WORKOS_CLIENT_ID = WORKOS_CLIENT_ID_ENV!;

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
  jwks ??= createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(WORKOS_CLIENT_ID)), {
    cooldownDuration: 5 * 60 * 1000,
    cacheMaxAge: 10 * 60 * 1000,
  });
  return jwks;
}
