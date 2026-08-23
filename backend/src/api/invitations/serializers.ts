/**
 * Response serializers for invitation routes.
 */

/**
 * Remove the secret `token` from an invitation before it is sent on an
 * authenticated response.
 *
 * The service layer already uses explicit `select`s that omit `token`
 * (audit #14); this is defense in depth so a future `include`-based query
 * can't leak the bearer secret that drives the unauthenticated
 * `POST /invitations/by-token/:token/accept` endpoint.
 */
export function omitToken<T extends object>(invitation: T): Omit<T, 'token'> {
  if (!('token' in invitation)) {
    return invitation;
  }
  const copy: Record<string, unknown> = { ...invitation };
  delete copy.token;
  return copy as Omit<T, 'token'>;
}
