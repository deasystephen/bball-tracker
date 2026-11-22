import { CLIENT_HEADERS, joinLinkByTokenUrl } from './api-urls';
import { log } from './log';

/**
 * What the public `GET /join/:token` returns for a team join link (#210): the
 * team's name and whether the link still takes requests. Nothing else is
 * public: no roster, no coach, no counts.
 */
export interface JoinLinkPreview {
  teamName: string;
  state: 'active' | 'expired' | 'full';
}

/**
 * Outcome of the server-side lookup, shaped like the invitation lookup's
 * (#720): only a 400 or 404 means the link is dead (unknown, or replaced by
 * the coach); a 429, a 5xx, an unreadable body or a failed fetch says nothing
 * about the link.
 */
export type JoinLookupResult =
  | { kind: 'ok'; link: JoinLinkPreview }
  | { kind: 'notFound' }
  | { kind: 'unavailable'; status?: number };

function unavailable(reason: 'network' | 'status' | 'body', status?: number): JoinLookupResult {
  // Reason and status only: never the URL or the token (a bearer secret
  // shared with a whole team). A JSON line through lib/log.ts.
  log.warn('Join link lookup unavailable', { reason, status: status ?? null });
  return { kind: 'unavailable', status };
}

function isPreview(value: unknown): value is JoinLinkPreview {
  if (typeof value !== 'object' || value === null) return false;
  const { teamName, state } = value as { teamName?: unknown; state?: unknown };
  return typeof teamName === 'string' && (state === 'active' || state === 'expired' || state === 'full');
}

export async function getJoinLink(token: string): Promise<JoinLookupResult> {
  const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
  let res: Response;
  try {
    res = await fetch(joinLinkByTokenUrl(apiUrl, token), {
      cache: 'no-store',
      headers: CLIENT_HEADERS,
    });
  } catch {
    return unavailable('network');
  }

  if (res.status === 400 || res.status === 404) return { kind: 'notFound' };
  if (!res.ok) return unavailable('status', res.status);

  try {
    const data = (await res.json()) as { link?: unknown };
    return isPreview(data.link) ? { kind: 'ok', link: data.link } : unavailable('body', res.status);
  } catch {
    return unavailable('body', res.status);
  }
}
