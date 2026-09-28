/**
 * The app-wide TanStack Query client.
 *
 * Lives in its own module (not `app/_layout.tsx`) so non-React code can reach
 * it — in particular the logout sequence, which must `clear()` the cache so
 * the next user never sees the previous user's teams/games/invitations
 * (query keys are not user-scoped; audit #19).
 */

import { QueryClient } from '@tanstack/react-query';
import { isNoSessionError } from './no-session-error';

/** One retry, as before, except where a retry cannot change the answer. */
export const QUERY_RETRIES = 1;

/**
 * A request refused locally because there is no session (#582) fails the same
 * way a second later. Retrying it only keeps a timer alive on a screen that
 * is about to unmount.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isNoSessionError(error)) return false;
  return failureCount < QUERY_RETRIES;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryQuery,
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false, // Not applicable in React Native
      gcTime: 10 * 60 * 1000, // 10 minutes garbage collection
    },
    mutations: {
      retry: 0,
    },
  },
});
