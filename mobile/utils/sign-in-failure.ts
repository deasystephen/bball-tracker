/**
 * Why a WorkOS sign-in did not complete, as ids and enums only (#963).
 *
 * The `/auth/callback` deep link is attacker-controllable (any app or page can
 * open `hooplings://auth/callback?error=…`), so the raw `error` param is never
 * logged or rendered: a known OAuth code is kept, anything else is `other`.
 */

import { log } from '../services/log';

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

/** Record a failed sign-in: a `log.warn` (Sentry breadcrumb) with the enums above. */
export function reportSignInFailure(failure: SignInFailure): void {
  log.warn('Sign-in failed', { ...failure });
}
