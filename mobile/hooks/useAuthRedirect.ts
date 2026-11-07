import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { useAuthUser, useIsAuthenticated } from '../store/auth-store';
import { AGE_CONFIRMATION_ROUTE, needsAgeConfirmation } from '../utils/age-gate';

/**
 * Sends the user to the login screen whenever an authenticated session is
 * lost (api-client logs out after an unrecoverable 401, or the user taps
 * Logout). Without this the app sat on the current tab with no token, every
 * request failing, and no way back to login except a restart (#349).
 *
 * Only reacts to the authenticated → unauthenticated transition; initial
 * routing on cold start is still app/index.tsx's job.
 *
 * Also keeps a signed-in account that has not answered the age question on
 * the age screen (#981): `postLoginRoute` sends a fresh sign-in there, but a
 * restored session learns it is unconfirmed later (the launch-time
 * `GET /auth/me` sync, or a 403 `age_confirmation_required` that the
 * api-client folds into the store), and a deep link or a push tap can land
 * anywhere. Whenever the stored user says `ageConfirmed: false` and the app is
 * not already on the age screen, it is replaced there.
 */
export function useAuthRedirect(): void {
  const router = useRouter();
  const pathname = usePathname();
  const isAuthenticated = useIsAuthenticated();
  const user = useAuthUser();
  const wasAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    if (wasAuthenticated.current && !isAuthenticated) {
      router.replace('/login');
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, router]);

  const mustConfirmAge = isAuthenticated && needsAgeConfirmation(user);
  useEffect(() => {
    if (mustConfirmAge && pathname !== AGE_CONFIRMATION_ROUTE) {
      router.replace(AGE_CONFIRMATION_ROUTE);
    }
  }, [mustConfirmAge, pathname, router]);
}
