import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useIsAuthenticated } from '../store/auth-store';

/**
 * Sends the user to the login screen whenever an authenticated session is
 * lost (api-client logs out after an unrecoverable 401, or the user taps
 * Logout). Without this the app sat on the current tab with no token, every
 * request failing, and no way back to login except a restart (#349).
 *
 * Only reacts to the authenticated → unauthenticated transition; initial
 * routing on cold start is still app/index.tsx's job.
 */
export function useAuthRedirect(): void {
  const router = useRouter();
  const isAuthenticated = useIsAuthenticated();
  const wasAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    if (wasAuthenticated.current && !isAuthenticated) {
      router.replace('/login');
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, router]);
}
