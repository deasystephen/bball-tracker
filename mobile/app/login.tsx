import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useAuthStore } from '../store/auth-store';
import { apiClient } from '../services/api-client';

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
      Alert.alert('Error', 'Failed to initiate login. Please try again.');
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

  const renderDevUser = ({ item }: { item: DevUser }) => (
    <TouchableOpacity
      style={styles.devUserItem}
      onPress={() => handleDevLogin(item.email)}
    >
      <Text style={styles.devUserName}>{item.name}</Text>
      <Text style={styles.devUserEmail}>{item.email}</Text>
      <Text style={styles.devUserRole}>{item.role}</Text>
    </TouchableOpacity>
  );

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

      {/* Dev login button - only in development */}
      {__DEV__ && (
        <TouchableOpacity
          style={[styles.devButton, isLoading && styles.buttonDisabled]}
          onPress={handleOpenDevLogin}
          disabled={isLoading}
        >
          <Text style={styles.devButtonText}>Dev Login (Test Users)</Text>
        </TouchableOpacity>
      )}

      {/* Dev user selection modal */}
      <Modal
        visible={showDevLogin}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowDevLogin(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select Test User</Text>
            <TouchableOpacity onPress={() => setShowDevLogin(false)}>
              <Text style={styles.modalClose}>Cancel</Text>
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
  devButton: {
    marginTop: 20,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 200,
    borderWidth: 1,
    borderColor: '#FF9500',
    backgroundColor: '#FFF9F0',
  },
  devButtonText: {
    color: '#FF9500',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
  },
  modalClose: {
    fontSize: 16,
    color: '#007AFF',
  },
  devUserList: {
    padding: 16,
  },
  devUserItem: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    marginBottom: 12,
  },
  devUserName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
    marginBottom: 4,
  },
  devUserEmail: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  devUserRole: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '500',
  },
});
