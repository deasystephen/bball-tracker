import { invitationByTokenUrl } from './api-urls';
import type { InvitationDetails } from './invitation-types';
import { log } from './log';

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

/** Why the lookup failed: the fetch threw, the API answered non-2xx, or a 2xx body was unusable. */
export type UnavailableReason = 'network' | 'status' | 'body';

function unavailable(reason: UnavailableReason, status?: number): LookupResult {
  // Reason and status only: never the URL or the token (the token is a bearer
  // secret). A JSON line through lib/log.ts, forwarded to Datadog (#966).
  log.warn('Invitation lookup unavailable', { reason, status: status ?? null });
  return { kind: 'unavailable', status };
}

export async function getInvitation(token: string): Promise<LookupResult> {
  const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
  let res: Response;
  try {
    res = await fetch(invitationByTokenUrl(apiUrl, token), {
      cache: 'no-store',
    });
  } catch {
    return unavailable('network');
  }

  if (res.status === 400 || res.status === 404) return { kind: 'notFound' };
  if (!res.ok) return unavailable('status', res.status);

  try {
    const data = (await res.json()) as { invitation?: InvitationDetails };
    return data.invitation ? { kind: 'ok', invitation: data.invitation } : unavailable('body', res.status);
  } catch {
    return unavailable('body', res.status);
  }
}
