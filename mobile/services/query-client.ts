/**
 * The app-wide TanStack Query client.
 *
 * Lives in its own module (not `app/_layout.tsx`) so non-React code can reach
 * it — in particular the logout sequence, which must `clear()` the cache so
 * the next user never sees the previous user's teams/games/invitations
 * (query keys are not user-scoped; audit #19).
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
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
