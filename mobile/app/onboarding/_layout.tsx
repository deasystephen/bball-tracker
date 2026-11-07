/**
 * Onboarding layout - headerless stack. The age screen (#981) cannot be
 * swiped away: a hardware back or a dismiss gesture must return to the same
 * question, never into the app (FTC age-screen guidance).
 */

import { Stack } from 'expo-router';

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="age" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
