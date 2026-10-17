/** The one place the public by-token invitation URLs are built (#720 review). */
export function invitationByTokenUrl(apiUrl: string, token: string): string {
  return `${apiUrl}/api/v1/invitations/by-token/${encodeURIComponent(token)}`;
}

export function acceptInvitationByTokenUrl(apiUrl: string, token: string): string {
  return `${invitationByTokenUrl(apiUrl, token)}/accept`;
}
