import { useEffect } from 'react';
import { LogBox } from 'react-native';
import { Stack } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ToastProvider } from '../components/Toast';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { Oswald_700Bold } from '@expo-google-fonts/oswald';
import { initAnalytics, trackEvent, AnalyticsEvents } from '../services/analytics';
import { initSentry } from '../services/sentry';
import { queryClient } from '../services/query-client';
import '../services/session-logout'; // registers logout side effects with the auth store
import { useNotificationSetup } from '../hooks/useNotifications';
import { useAuthRedirect } from '../hooks/useAuthRedirect';
import '../i18n/config'; // Initialize i18n

// Initialize Sentry as early as possible so crashes during startup are captured.
initSentry();

if (__DEV__) {
  LogBox.ignoreAllLogs();
}

SplashScreen.preventAutoHideAsync();

/**
 * Root layout - navigation is handled by index.tsx after mount
 * Includes i18n initialization and theme support
 */
function NotificationHandler() {
  useNotificationSetup();
  return null;
}

/** Routes to /login when the session is lost mid-app (see useAuthRedirect). */
function AuthRedirectHandler() {
  useAuthRedirect();
  return null;
}

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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <NotificationHandler />
              <AuthRedirectHandler />
              <Stack
                screenOptions={{
                  headerShown: false,
                }}
              />
            </ToastProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
