import { CLIENT_HEADERS, acceptInvitationByTokenUrl } from './api-urls';

/**
 * The browser's "Accept without app" call, `POST /invitations/by-token/:token/accept`
 * (`app/invite/[token]/invite-client.tsx`). A lib function, like the
 * server-side lookup, so the request it sends is tested as sent: it carries
 * `X-Hooplings-Client: web` (#964), which the API logs as `client` on the
 * accept's lines.
 */
export type AcceptResult = { ok: true } | { ok: false; message: string };

export const ACCEPT_FALLBACK_ERROR = 'Something went wrong. Please try again.';
export const ACCEPT_NETWORK_ERROR = 'Network error. Please check your connection and try again.';

export async function acceptInvitation(apiUrl: string, token: string): Promise<AcceptResult> {
  try {
    const res = await fetch(acceptInvitationByTokenUrl(apiUrl, token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS },
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) return { ok: false, message: data.error ?? ACCEPT_FALLBACK_ERROR };
    return { ok: true };
  } catch {
    return { ok: false, message: ACCEPT_NETWORK_ERROR };
  }
}
