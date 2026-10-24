/**
 * Sent on every API call the site makes, from the server (the lookup) and from
 * the browser (the accept): the API logs it as `client` (#963, #964), which is
 * how the invite funnel tells web views and accepts from the app's. The value
 * follows the contract in docs/architecture/backend-services.md (Logging);
 * the API allows the header in its CORS preflight.
 */
export const CLIENT_HEADERS = { 'X-Hooplings-Client': 'web' } as const;

/** The one place the public by-token invitation URLs are built (#720 review). */
export function invitationByTokenUrl(apiUrl: string, token: string): string {
  return `${apiUrl}/api/v1/invitations/by-token/${encodeURIComponent(token)}`;
}

export function acceptInvitationByTokenUrl(apiUrl: string, token: string): string {
  return `${invitationByTokenUrl(apiUrl, token)}/accept`;
}
