import { useEffect, useRef } from 'react';
import { trackEvent, AnalyticsEvents, type InviteLinkState } from '../services/analytics';
import type { InvitationByToken } from './useInvitationByToken';

/**
 * `invite_link_viewed` for the `/invite/[token]` deep link (#967): what the
 * invitee saw, whether they were signed in, and where the link came from.
 * Its own hook so the screen only reports what it already decided to render.
 */

export interface InviteLinkViewInput {
  /** The route's `token` param; the event is sent once per token per mount. */
  token: string | undefined;
  /** The `src` query param: `web` from the web invite page's Open in App button (`?src=web`, #964). */
  src: string | undefined;
  isLoading: boolean;
  /** `useQueryErrorState(...).failed` for a transient failure (network, 429, 5xx). */
  failed: boolean;
  /** `useQueryErrorState(...).retrying`: Try Again is in flight. */
  retrying: boolean;
  error: unknown;
  invitation: InvitationByToken | undefined;
  isAuthenticated: boolean;
}

/** `web` only for the web page's button; every other entry (the email's Universal Link, a pasted link) is `link`. */
export function inviteLinkSource(src: string | undefined): 'web' | 'link' {
  return src === 'web' ? 'web' : 'link';
}

/**
 * The state the invite screen renders, in the screen's own branch order, or
 * null while there is nothing to report yet (loading, or Try Again in flight).
 */
export function inviteLinkState(
  { isLoading, failed, retrying, error, invitation }: Pick<
    InviteLinkViewInput,
    'isLoading' | 'failed' | 'retrying' | 'error' | 'invitation'
  >,
  now: Date = new Date()
): InviteLinkState | null {
  if (isLoading || retrying) return null;
  if (failed) return 'unavailable';
  if (error || !invitation) return 'not_found';
  if (invitation.status === 'ACCEPTED') return 'accepted';
  if (invitation.status === 'REJECTED') return 'rejected';
  if (invitation.status === 'CANCELLED') return 'cancelled';
  if (invitation.status === 'EXPIRED' || (invitation.expiresAt != null && new Date(invitation.expiresAt) < now)) {
    return 'expired';
  }
  return 'pending';
}

/**
 * Send `invite_link_viewed` once per token per mount, as soon as the screen
 * has an outcome to show. A signed-out invitee who taps Log In comes back to
 * a fresh mount after sign-in, which reports again with `authenticated: true`.
 */
export function useInviteLinkViewed(input: InviteLinkViewInput): void {
  const reportedTokenRef = useRef<string | null>(null);
  const state = inviteLinkState(input);
  const { token, src, invitation, isAuthenticated } = input;
  const kind = invitation ? (invitation.kind === 'guardian' ? 'guardian' : 'team') : undefined;

  useEffect(() => {
    if (!state || token === undefined || reportedTokenRef.current === token) return;
    reportedTokenRef.current = token;
    trackEvent(AnalyticsEvents.INVITE_LINK_VIEWED, {
      state,
      ...(kind ? { kind } : {}),
      authenticated: isAuthenticated,
      source: inviteLinkSource(src),
    });
  }, [state, token, kind, isAuthenticated, src]);
}
