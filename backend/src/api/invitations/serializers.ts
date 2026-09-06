/**
 * Response serializers for invitation routes.
 */

import { omitSecret } from '../serializers';

/**
 * Remove the secret `token` from an invitation before it is sent on an
 * authenticated response.
 *
 * The service layer already uses explicit `select`s that omit `token`
 * (audit #14); this is defense in depth so a future `include`-based query
 * can't leak the bearer secret that drives the unauthenticated
 * `POST /invitations/by-token/:token/accept` endpoint.
 *
 * Thin wrapper over the shared `omitSecret` so every bearer secret in the API
 * (invitation tokens today, competition join codes when #492 lands) is
 * stripped by ONE implementation.
 */
export function omitToken<T extends object>(invitation: T): Omit<T, 'token'> {
  return omitSecret(invitation, 'token');
}
