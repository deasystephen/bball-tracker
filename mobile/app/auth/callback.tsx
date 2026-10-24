/**
 * OAuth callback route for hooplings://auth/callback?code=<code>&state=<state>
 *
 * WorkOS redirects the browser back to this deep link after the user signs in.
 * Expo Router matches the path to this screen, which exchanges the authorization
 * code for a session token and then routes the user into the app. Without a real
 * route here, the incoming deep link lands on Expo Router's "Unmatched Route"
 * screen (see login.tsx's redirect URI built with `Linking.createURL('auth/callback')`).
 *
 * Security (audit #5): the custom scheme can be claimed by any app, so before
 * exchanging anything this screen requires the echoed `state` to match the
 * sign-in this device started (utils/pkce.ts) and sends that sign-in's PKCE
 * `code_verifier` along with the code. A deep link with a foreign or replayed
 * `state` is refused without contacting the backend.
 */

import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedView, ThemedText, LoadingSpinner, Button } from '../../components';
import { useTheme } from '../../hooks/useTheme';
import { useAuthActions, type AuthCallbackResponse } from '../../store/auth-store';
import { isAxiosError } from 'axios';
import { apiClient, type NormalizedApiError } from '../../services/api-client';
import { captureException } from '../../services/sentry';
import { log } from '../../services/log';
import { spacing } from '../../theme';
import { postLoginRoute } from '../../utils/role-onboarding';
import { consumePendingLogin } from '../../utils/pkce';
import { useTranslation } from '../../i18n';
import {
  callbackParamFailure,
  failureStatus,
  reportSignInFailure,
  type OAuthErrorCode,
  type SignInFailure,
} from '../../utils/sign-in-failure';

/**
 * Errors that are knowable from the deep link itself (WorkOS returned an error,
 * or no code came back) are derived during render — no effect/state needed.
 * Only the async token-exchange failure has to live in state.
 *
 * The `error` query param is attacker-controllable (anyone can open
 * hooplings://auth/callback?error=…), so it is never rendered verbatim —
 * known OAuth codes map to our own copy and everything else gets a generic
 * message (audit #74). Each maps to an i18n key under `authCallback`.
 */
const OAUTH_ERROR_KEYS: Record<OAuthErrorCode, string> = {
  access_denied: 'authCallback.accessDenied',
  invalid_request: 'authCallback.invalidRequest',
  server_error: 'authCallback.serverError',
  temporarily_unavailable: 'authCallback.temporarilyUnavailable',
};

/**
 * 403 `email_not_verified` (#907): the address matches a player a coach added,
 * and only a verified address may claim that account. Retrying changes nothing
 * until the address is verified, so this gets its own copy, not "try again",
 * and is not reported to Sentry (an expected refusal, like every 4xx).
 */
export const EMAIL_NOT_VERIFIED_CODE = 'email_not_verified';

function isEmailNotVerified(err: unknown): boolean {
  return isAxiosError(err) && (err as NormalizedApiError).apiError?.code === EMAIL_NOT_VERIFIED_CODE;
}

/** The i18n key for a failure the params already show (`callbackParamFailure`), or null. */
function getParamErrorKey(failure: SignInFailure | null): string | null {
  if (!failure) return null;
  if (failure.stage === 'missing_code') return 'authCallback.noCode';
  return failure.oauth_error && failure.oauth_error !== 'other'
    ? OAUTH_ERROR_KEYS[failure.oauth_error]
    : 'authCallback.incomplete';
}

export default function AuthCallbackScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { setAuthToken, setUser } = useAuthActions();
  const { code, state, error: oauthError } = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
  }>();

  const paramFailure = callbackParamFailure(oauthError, code);
  const paramError = getParamErrorKey(paramFailure);
  /** i18n key of the token-exchange failure. */
  const [exchangeErrorKey, setExchangeErrorKey] = useState<string | null>(null);
  // Guard so the code is only exchanged once, even if the effect re-runs.
  const exchangedRef = useRef(false);

  // A refused callback is never silent: a warning (#963) and `sign_in_failed`
  // (#967), once per distinct failure, enums only, so a re-render repeats nothing and a second refused
  // deep link into the same mounted screen is still reported.
  const failureStage = paramFailure?.stage;
  const failureCode = paramFailure?.oauth_error;
  const reportedFailureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!failureStage) return;
    const key = `${failureStage}:${failureCode ?? ''}`;
    if (reportedFailureRef.current === key) return;
    reportedFailureRef.current = key;
    reportSignInFailure(failureCode ? { stage: failureStage, oauth_error: failureCode } : { stage: failureStage });
  }, [failureStage, failureCode]);

  useEffect(() => {
    if (paramError || !code) return;
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    (async () => {
      try {
        const pending = await consumePendingLogin(state);
        if (!pending) {
          reportSignInFailure({ stage: 'state_mismatch' });
          setExchangeErrorKey('authCallback.foreignState');
          return;
        }
        const response = await apiClient.get<AuthCallbackResponse>('/auth/callback', {
          params: { code, state: pending.state, code_verifier: pending.verifier },
        });
        const { accessToken, refreshToken, user, claimedInvite, wasManaged } = response.data;

        setAuthToken(accessToken, refreshToken ?? null);
        setUser(user, { claimedInvite, wasManaged });

        router.replace(await postLoginRoute(user));
      } catch (err) {
        if (isEmailNotVerified(err)) {
          reportSignInFailure({ stage: 'exchange', status: failureStatus(err) });
          setExchangeErrorKey('authCallback.emailNotVerified');
          return;
        }
        captureException(err, { flow: 'auth-callback' });
        log.error('Token exchange error', { error: err });
        reportSignInFailure({ stage: 'exchange', status: failureStatus(err) });
        setExchangeErrorKey('authCallback.exchangeFailed');
      }
    })();
  }, [code, state, paramError, router, setAuthToken, setUser]);

  const errorKey = paramError ?? exchangeErrorKey;

  if (errorKey) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="close-circle-outline" size={64} color={colors.error} />
          <ThemedText variant="h2" heading style={styles.title}>
            {t('authCallback.title')}
          </ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            {t(errorKey)}
          </ThemedText>
          <Button title={t('authCallback.back')} onPress={() => router.replace('/login')} style={styles.btn} />
        </View>
      </ThemedView>
    );
  }

  return <LoadingSpinner message={t('authCallback.signingIn')} fullScreen />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    textAlign: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  subtitle: {
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  btn: {
    marginTop: spacing.md,
    width: '100%',
  },
});
