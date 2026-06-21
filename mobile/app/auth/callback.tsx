/**
 * OAuth callback route for bball-tracker://auth/callback?code=<code>
 *
 * WorkOS redirects the browser back to this deep link after the user signs in.
 * Expo Router matches the path to this screen, which exchanges the authorization
 * code for a session token and then routes the user into the app. Without a real
 * route here, the incoming deep link lands on Expo Router's "Unmatched Route"
 * screen (see login.tsx's redirect URI built with `Linking.createURL('auth/callback')`).
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

export default function AuthCallbackScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { setAuthToken, setUser } = useAuthActions();
  const { code, error: oauthError } = useLocalSearchParams<{
    code?: string;
    error?: string;
  }>();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Guard so the code is only exchanged once, even if the effect re-runs.
  const exchangedRef = useRef(false);

  useEffect(() => {
    if (exchangedRef.current) return;
    exchangedRef.current = true;

    if (oauthError) {
      setErrorMessage(oauthError);
      return;
    }

    if (!code) {
      setErrorMessage('No authorization code was returned. Please try signing in again.');
      return;
    }

    (async () => {
      try {
        const response = await apiClient.get('/auth/callback', { params: { code } });
        const { accessToken, user } = response.data;

        setAuthToken(accessToken);
        setUser(user);

        router.replace('/(tabs)/home');
      } catch (err) {
        captureException(err, { flow: 'auth-callback' });
        console.error('Token exchange error:', err);
        setErrorMessage('Failed to complete sign in. Please try again.');
      }
    })();
  }, [code, oauthError, router, setAuthToken, setUser]);

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
