/**
 * WorkOS client configuration and initialization
 */

import { WorkOS } from '@workos-inc/node';

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
