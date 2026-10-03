/**
 * `screen_viewed` from one place (#616): the root layout mounts this once, so
 * every route is covered without a screen having to remember.
 *
 * Expo Router's `useSegments()` gives the route pattern (`['teams', '[id]']`),
 * which is what is sent: an id, a token or any other param value never leaves
 * the device. `usePathname()` is only the trigger, so that moving from one
 * team to another (same pattern, different path) counts as a new view.
 */
import { useEffect, useRef } from 'react';
import { usePathname, useSegments } from 'expo-router';
import { trackEvent, AnalyticsEvents, screenViewFromSegments } from '../services/analytics';

export function useScreenViewTracking(): void {
  const pathname = usePathname();
  const segments = useSegments();
  const lastPathname = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || pathname === lastPathname.current) return;
    lastPathname.current = pathname;
    trackEvent(AnalyticsEvents.SCREEN_VIEWED, screenViewFromSegments(segments));
  }, [pathname, segments]);
}
