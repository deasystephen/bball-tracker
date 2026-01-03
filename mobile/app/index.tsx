import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../store/auth-store';

/**
 * Root index screen - handles initial routing based on auth state
 * Uses ref to ensure navigation only happens once after mount
 */
export default function Index() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuthStore();
  const hasNavigated = useRef(false);

  useEffect(() => {
    // Prevent multiple navigations
    if (hasNavigated.current || isLoading) {
      return;
    }

    // Wait for component to fully mount and navigation to be ready
    // Use multiple async ticks to ensure everything is initialized
    const navigate = async () => {
      // Wait for next event loop cycle
      await new Promise(resolve => setTimeout(resolve, 150));
      
      if (hasNavigated.current) {
        return;
      }

      try {
        hasNavigated.current = true;
        if (isAuthenticated) {
          router.replace('/(tabs)/home');
        } else {
          router.replace('/login');
        }
      } catch (error) {
        // If navigation fails, reset flag to retry
        hasNavigated.current = false;
        console.warn('Navigation failed, will retry:', error);
      }
    };

    navigate();
  }, [isAuthenticated, isLoading, router]);

  // Show loading screen while determining route
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#007AFF" />
      <Text style={styles.text}>Loading...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  text: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },
});
