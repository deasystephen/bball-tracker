import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ToastProvider } from '../components/Toast';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { Oswald_700Bold } from '@expo-google-fonts/oswald';
import { initAnalytics, trackEvent, AnalyticsEvents } from '../services/analytics';
import '../i18n/config'; // Initialize i18n

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false, // Not applicable in React Native
      gcTime: 10 * 60 * 1000, // 10 minutes garbage collection
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * Root layout - navigation is handled by index.tsx after mount
 * Includes i18n initialization and theme support
 */
export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Oswald_700Bold,
  });

  useEffect(() => {
    initAnalytics().then(() => {
      trackEvent(AnalyticsEvents.APP_OPENED);
    });
  }, []);

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Stack
              screenOptions={{
                headerShown: false,
              }}
            />
          </ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
