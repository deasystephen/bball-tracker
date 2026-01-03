import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useAuthStore } from '../store/auth-store';
import { apiClient } from '../services/api-client';

/**
 * Login screen - handles WorkOS authentication flow
 */
export default function Login() {
  const router = useRouter();
  const { setAuthToken, setUser } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);

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
      Alert.alert('Error', 'Failed to initiate login. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Basketball Tracker</Text>
      <Text style={styles.subtitle}>Sign in to continue</Text>

      <TouchableOpacity
        style={[styles.button, isLoading && styles.buttonDisabled]}
        onPress={handleLogin}
        disabled={isLoading}
      >
        <Text style={styles.buttonText}>
          {isLoading ? 'Loading...' : 'Sign In'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#000',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 200,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
});
