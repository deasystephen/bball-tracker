import type { InvitationDetails } from '../app/invite/[token]/invite-client';

/**
 * Outcome of the server-side `GET /invitations/by-token/:token` lookup (#720).
 * Only a 400 or 404 means the link is dead; a 429, a 5xx, an unreadable body or
 * a failed fetch says nothing about the token, so the page must not tell the
 * recipient to ask for a resend (resend supersedes, and kills a valid link).
 */
export type LookupResult =
  | { kind: 'ok'; invitation: InvitationDetails }
  | { kind: 'notFound' }
  | { kind: 'unavailable'; status?: number };

function unavailable(status?: number): LookupResult {
  // Status only: never the URL or the token (the token is a bearer secret).
  console.warn('Invitation lookup unavailable', { status: status ?? 'network' });
  return { kind: 'unavailable', status };
}

export async function getInvitation(token: string): Promise<LookupResult> {
  const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/v1/invitations/by-token/${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
  } catch {
    return unavailable();
  }

  if (res.status === 400 || res.status === 404) return { kind: 'notFound' };
  if (!res.ok) return unavailable(res.status);

  try {
    const data = (await res.json()) as { invitation?: InvitationDetails };
    return data.invitation ? { kind: 'ok', invitation: data.invitation } : unavailable(res.status);
  } catch {
    return unavailable(res.status);
  }
}
