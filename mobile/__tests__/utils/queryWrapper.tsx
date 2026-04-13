/**
 * Test utilities for React Query-backed hooks.
 *
 * Provides a fresh `QueryClient` per test with retries disabled so
 * `useQuery` / `useMutation` hooks resolve/reject deterministically
 * in a single tick.
 */

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export interface QueryWrapper {
  wrapper: React.FC<{ children: React.ReactNode }>;
  client: QueryClient;
}

export function createQueryWrapper(): QueryWrapper {
  const client = createTestQueryClient();
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, client };
}
