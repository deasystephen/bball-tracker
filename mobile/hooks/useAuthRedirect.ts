import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { useAuthStore, useAuthUser, useIsAuthenticated } from '../store/auth-store';
import { AGE_CONFIRMATION_ROUTE, needsAgeConfirmation } from '../utils/age-gate';
import { isSafeReturnPath, setPendingReturnPath } from '../utils/return-path';

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
/** Routes where `postLoginRoute` decides the next screen (cold start, sign-in, the callback, the carousel) and the age screen itself. */
const POST_LOGIN_OWNED: ReadonlySet<string> = new Set(['/', '/index', '/login', '/auth/callback', '/onboarding', AGE_CONFIRMATION_ROUTE]);

export function useAuthRedirect(): void {
  const router = useRouter();
  const pathname = usePathname();
  const isAuthenticated = useIsAuthenticated();
  const user = useAuthUser();
  const wasAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    if (wasAuthenticated.current && !isAuthenticated) {
      // After an under-age refusal the age screen keeps the explanation on
      // screen and sends the person to sign-in itself (#981).
      if (useAuthStore.getState().lastSessionEnd !== 'age_refused') {
        router.replace('/login');
      }
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated, router]);

  const mustConfirmAge = isAuthenticated && needsAgeConfirmation(user);
  useEffect(() => {
    // The sign-in paths route through `postLoginRoute` themselves; replacing
    // here as well would mount the age screen twice.
    if (mustConfirmAge && !POST_LOGIN_OWNED.has(pathname)) {
      // A deep link (an invitation, a game) survives the question: it is the
      // pending return path `postLoginRoute` consumes after the answer.
      if (isSafeReturnPath(pathname)) void setPendingReturnPath(pathname);
      router.replace(AGE_CONFIRMATION_ROUTE);
    }
  }, [mustConfirmAge, pathname, router]);
}
