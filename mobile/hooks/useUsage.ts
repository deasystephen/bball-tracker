/**
 * React Query hook for the current user's usage metering.
 *
 * Backs the Profile usage meter: fetches GET /auth/me/usage which returns each
 * metered feature's current count vs the tier limit. `limit` is `null` for
 * unlimited (paid) tiers.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';

export type SubscriptionTier = 'FREE' | 'PREMIUM' | 'LEAGUE';

export interface UsageMetric {
  count: number;
  /** `null` means unlimited. */
  limit: number | null;
  limitReached: boolean;
}

export interface Usage {
  tier: SubscriptionTier;
  teams: UsageMetric;
  seasons: UsageMetric;
}

interface UsageResponse {
  success: boolean;
  usage: Usage;
}

export const usageKeys = {
  all: ['usage'] as const,
  me: () => [...usageKeys.all, 'me'] as const,
};

/**
 * Fetch the current user's usage vs tier limits.
 */
export function useUsage() {
  return useQuery({
    queryKey: usageKeys.me(),
    queryFn: async () => {
      const response = await apiClient.get<UsageResponse>('/auth/me/usage');
      return response.data.usage;
    },
    // Usage is cheap to refetch and changes when teams are added/removed;
    // a short stale time keeps the meter fresh without hammering the API.
    staleTime: 30_000,
  });
}
