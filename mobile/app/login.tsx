import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal, FlatList, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useAuthStore } from '../store/auth-store';
import { apiClient } from '../services/api-client';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { borderRadius } from '../theme/border-radius';
import { typography } from '../theme/typography';

interface DevUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

/**
 * Login screen - handles WorkOS authentication flow
 */
export default function Login() {
  const router = useRouter();
  const { setAuthToken, setUser } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);
  const [showDevLogin, setShowDevLogin] = useState(false);
  const [devUsers, setDevUsers] = useState<DevUser[]>([]);

  // Handle deep link callback from OAuth redirect
  useEffect(() => {
    const handleDeepLink = async (event: { url: string }) => {
      const { url } = event;
      const parsed = Linking.parse(url);

      // Check if this is an auth callback
      if (parsed.path === 'auth/callback' || parsed.queryParams?.code) {
        const code = parsed.queryParams?.code as string;
        const error = parsed.queryParams?.error as string | undefined;

        if (error) {
          Alert.alert('Authentication Error', error);
          setIsLoading(false);
          return;
        }

        if (code) {
          try {
            setIsLoading(true);
            // Exchange code for token via backend
            const response = await apiClient.get('/auth/callback', {
              params: { code },
            });

            const { accessToken, user } = response.data;

            // Store token and user
            setAuthToken(accessToken);
            setUser(user);

            // Navigate to home
            router.replace('/(tabs)/home');
          } catch (error) {
            console.error('Token exchange error:', error);
            Alert.alert('Error', 'Failed to complete authentication. Please try again.');
          } finally {
            setIsLoading(false);
          }
        }
      }
    };

    // Listen for deep links
    const subscription = Linking.addEventListener('url', handleDeepLink);

    // Check if app was opened via deep link
    Linking.getInitialURL().then((url) => {
      if (url) {
        handleDeepLink({ url });
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router, setAuthToken, setUser]);

  const handleLogin = async () => {
    try {
      setIsLoading(true);
      // Get authorization URL from backend (request JSON format for mobile)
      // Use mobile redirect URI that deep links back to app
      const mobileRedirectUri = Linking.createURL('auth/callback', {});
      const response = await apiClient.get('/auth/login', {
        params: {
          format: 'json',
          redirect_uri: mobileRedirectUri,
        },
      });
      const { url } = response.data;

      // Open the authorization URL in browser
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Error', 'Cannot open browser. Please check your device settings.');
        setIsLoading(false);
      }
    } catch (error) {
      console.error('Login error:', error);
      const baseURL = apiClient.defaults.baseURL || 'unknown';
      const errMsg = error instanceof Error ? error.message : String(error);
      Alert.alert('Login Error', `URL: ${baseURL}\n\n${errMsg}`);
      setIsLoading(false);
    }
  };

  // Dev login functions (development only)
  const handleOpenDevLogin = async () => {
    try {
      setIsLoading(true);
      const response = await apiClient.get('/auth/dev-users');
      setDevUsers(response.data.users);
      setShowDevLogin(true);
    } catch (error) {
      console.error('Error fetching dev users:', error);
      Alert.alert('Error', 'Failed to load test users. Is the backend running?');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDevLogin = async (email: string) => {
    try {
      setIsLoading(true);
      setShowDevLogin(false);

      const response = await apiClient.post('/auth/dev-login', { email });
      const { accessToken, user } = response.data;

      setAuthToken(accessToken);
      setUser(user);

      router.replace('/(tabs)/home');
    } catch (error) {
      console.error('Dev login error:', error);
      Alert.alert('Error', 'Dev login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const { colors } = useTheme();

  const renderDevUser = ({ item }: { item: DevUser }) => (
    <TouchableOpacity
      style={[styles.devUserItem, { backgroundColor: colors.backgroundTertiary }]}
      onPress={() => handleDevLogin(item.email)}
    >
      <Text style={[styles.devUserName, { color: colors.text }]}>{item.name}</Text>
      <Text style={[styles.devUserEmail, { color: colors.textSecondary }]}>{item.email}</Text>
      <Text style={[styles.devUserRole, { color: colors.accent }]}>{item.role}</Text>
    </TouchableOpacity>
  );

  return (
    <LinearGradient
      colors={[colors.primary, colors.primaryDark]}
      style={styles.container}
    >
      <Text style={styles.title}>Basketball Tracker</Text>
      <Text style={styles.subtitle}>Sign in to continue</Text>

      {isLoading ? (
        <ActivityIndicator color="#FFFFFF" size="large" style={styles.loader} />
      ) : (
        <>
          <TouchableOpacity
            onPress={handleLogin}
            disabled={isLoading}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            accessibilityState={{ disabled: isLoading }}
            style={styles.signInTouchable}
          >
            <LinearGradient
              colors={[colors.accent, colors.accentDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.signInButton}
            >
              <Text style={styles.signInButtonText}>Sign In</Text>
            </LinearGradient>
          </TouchableOpacity>

          {/* Dev login button - only in development */}
          {__DEV__ && (
            <TouchableOpacity
              style={styles.devButton}
              onPress={handleOpenDevLogin}
              disabled={isLoading}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Developer login with test users"
            >
              <Text style={styles.devButtonText}>Dev Login (Test Users)</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {/* Dev user selection modal */}
      <Modal
        visible={showDevLogin}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowDevLogin(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Select Test User</Text>
            <TouchableOpacity
              onPress={() => setShowDevLogin(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={[styles.modalClose, { color: colors.primary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={devUsers}
            renderItem={renderDevUser}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.devUserList}
          />
        </View>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  title: {
    ...typography.display,
    color: '#FFFFFF',
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.body,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: spacing.xxl,
    textAlign: 'center',
  },
  loader: {
    marginTop: spacing.lg,
  },
  signInTouchable: {
    width: '100%',
  },
  signInButton: {
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    borderRadius: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signInButtonText: {
    ...typography.bodyBold,
    color: '#FFFFFF',
    fontSize: 17,
    letterSpacing: 0.3,
  },
  devButton: {
    marginTop: spacing.lg,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.md,
    minWidth: 200,
    minHeight: 48,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  devButtonText: {
    ...typography.captionBold,
    color: '#FFFFFF',
    fontSize: 14,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderBottomWidth: 1,
  },
  modalTitle: {
    ...typography.h3,
  },
  modalClose: {
    ...typography.body,
    padding: spacing.sm,
  },
  devUserList: {
    padding: spacing.md,
  },
  devUserItem: {
    padding: spacing.md,
    borderRadius: borderRadius.sm,
    marginBottom: spacing.sm,
    minHeight: 48,
  },
  devUserName: {
    ...typography.bodyBold,
    marginBottom: spacing.xxs,
  },
  devUserEmail: {
    ...typography.caption,
    marginBottom: spacing.xxs,
  },
  devUserRole: {
    ...typography.footnoteBold,
  },
});
