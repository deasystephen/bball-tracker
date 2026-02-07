import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../store/auth-store';

const ONBOARDED_KEY = 'hasOnboarded';

/**
 * Root index screen - handles initial routing based on auth state
 * Uses ref to ensure navigation only happens once after mount
 */
export default function Index() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuthStore();
  const hasNavigated = useRef(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [hasOnboarded, setHasOnboarded] = useState(false);

  // Check onboarding status on mount
  useEffect(() => {
    AsyncStorage.getItem(ONBOARDED_KEY).then((value) => {
      setHasOnboarded(value === 'true');
      setOnboardingChecked(true);
    });
  }, []);

  useEffect(() => {
    // Prevent multiple navigations; wait for onboarding check
    if (hasNavigated.current || isLoading || !onboardingChecked) {
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
        if (!hasOnboarded) {
          router.replace('/onboarding');
        } else if (isAuthenticated) {
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
  }, [isAuthenticated, isLoading, onboardingChecked, hasOnboarded, router]);

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
