/**
 * OAuth callback route for bball-tracker://auth/callback?code=<code>&state=<state>
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
import { useAuthActions } from '../../store/auth-store';
import { apiClient } from '../../services/api-client';
import { captureException } from '../../services/sentry';
import { spacing } from '../../theme';
import { postLoginRoute } from '../../utils/role-onboarding';
import { consumePendingLogin } from '../../utils/pkce';

/**
 * Errors that are knowable from the deep link itself (WorkOS returned an error,
 * or no code came back) are derived during render — no effect/state needed.
 * Only the async token-exchange failure has to live in state.
 *
 * The `error` query param is attacker-controllable (anyone can open
 * bball-tracker://auth/callback?error=…), so it is never rendered verbatim —
 * known OAuth codes map to our own copy and everything else gets a generic
 * message (audit #74).
 */
const OAUTH_ERROR_COPY: Record<string, string> = {
  access_denied: 'Sign-in was cancelled. You can try again whenever you like.',
  invalid_request: 'The sign-in link was invalid. Please try signing in again.',
  server_error: 'The sign-in service hit a problem. Please try again in a moment.',
  temporarily_unavailable: 'The sign-in service is temporarily unavailable. Please try again in a moment.',
};

function getParamError(oauthError?: string, code?: string): string | null {
  if (oauthError) {
    return OAUTH_ERROR_COPY[oauthError] ?? 'Sign-in did not complete. Please try signing in again.';
  }
  if (!code) return 'No authorization code was returned. Please try signing in again.';
  return null;
}

export default function AuthCallbackScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { setAuthToken, setUser } = useAuthActions();
  const { code, state, error: oauthError } = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
  }>();

  const paramError = getParamError(oauthError, code);
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  // Guard so the code is only exchanged once, even if the effect re-runs.
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (paramError || !code) return;
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    (async () => {
      try {
        const pending = await consumePendingLogin(state);
        if (!pending) {
          setExchangeError(
            'This sign-in link did not come from a sign-in started on this device, or it has expired. Please try again.'
          );
          return;
        }
        const response = await apiClient.get('/auth/callback', {
          params: { code, state: pending.state, code_verifier: pending.verifier },
        });
        const { accessToken, refreshToken, user } = response.data;

        setAuthToken(accessToken, refreshToken ?? null);
        setUser(user);

        router.replace(await postLoginRoute(user));
      } catch (err) {
        captureException(err, { flow: 'auth-callback' });
        console.error('Token exchange error:', err);
        setExchangeError('Failed to complete sign in. Please try again.');
      }
    })();
  }, [code, state, paramError, router, setAuthToken, setUser]);

  const errorMessage = paramError ?? exchangeError;

  if (errorMessage) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={styles.content}>
          <Ionicons name="close-circle-outline" size={64} color={colors.error} />
          <ThemedText variant="h2" style={styles.title}>
            Sign In Failed
          </ThemedText>
          <ThemedText variant="body" color="textSecondary" style={styles.subtitle}>
            {errorMessage}
          </ThemedText>
          <Button title="Back to Sign In" onPress={() => router.replace('/login')} style={styles.btn} />
        </View>
      </ThemedView>
    );
  }

  return <LoadingSpinner message="Signing you in…" fullScreen />;
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
