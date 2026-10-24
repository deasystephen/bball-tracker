/**
 * Why a WorkOS sign-in did not complete, as ids and enums only: a `log.warn`
 * for on-call (#963) and the `sign_in_failed` Amplitude event for the funnel
 * (#967), from one call so the two never disagree.
 *
 * The `/auth/callback` deep link is attacker-controllable (any app or page can
 * open `hooplings://auth/callback?error=…`), so the raw `error` param is never
 * logged, tracked or rendered: a known OAuth code is kept, anything else is
 * `other`.
 */

import { log } from '../services/log';
import { trackEvent, AnalyticsEvents } from '../services/analytics';

/** The OAuth `error` codes the callback screen has its own copy for. */
export const OAUTH_ERROR_CODES = ['access_denied', 'invalid_request', 'server_error', 'temporarily_unavailable'] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export type SignInFailureStage =
  | 'initiate'
  | 'browser_dismissed'
  | 'oauth_error'
  | 'missing_code'
  | 'state_mismatch'
  | 'exchange';

export interface SignInFailure {
  stage: SignInFailureStage;
  /** Only on `oauth_error`: the allow-listed code, or `other`. */
  oauth_error?: OAuthErrorCode | 'other';
  /** HTTP status of a failed API call, when there was a response. */
  status?: number;
}

export function isOAuthErrorCode(value: string | undefined): value is OAuthErrorCode {
  return value !== undefined && (OAUTH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The failure the callback's own params already show (WorkOS returned an
 * `error`, or no `code` came back), or null when the exchange can proceed.
 */
export function callbackParamFailure(oauthError?: string, code?: string): SignInFailure | null {
  if (oauthError) return { stage: 'oauth_error', oauth_error: isOAuthErrorCode(oauthError) ? oauthError : 'other' };
  if (!code) return { stage: 'missing_code' };
  return null;
}

/** The HTTP status of a failed API call, or undefined when nothing answered. */
export function failureStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Record a failed sign-in: a `log.warn` (Sentry breadcrumb) and
 * `sign_in_failed` (#967), with the enums above. `status` is left out, never
 * sent as undefined, when nothing answered.
 */
export function reportSignInFailure(failure: SignInFailure): void {
  const props: SignInFailure = { stage: failure.stage };
  if (failure.oauth_error !== undefined) props.oauth_error = failure.oauth_error;
  if (failure.status !== undefined) props.status = failure.status;
  log.warn('Sign-in failed', { ...props });
  trackEvent(AnalyticsEvents.SIGN_IN_FAILED, props);
}
