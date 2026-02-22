import { create } from 'zustand';
import { AppState, AppStateStatus } from 'react-native';
import { apiClient } from '../services/api-client';
import { SubscriptionTier, Feature, Entitlements } from '../../shared/types';

interface EntitlementsState {
  tier: SubscriptionTier;
  features: Record<Feature, boolean>;
  limits: { maxTeams: number; maxSeasons: number };
  expiresAt: string | null;
  isLoaded: boolean;
  fetchEntitlements: () => Promise<void>;
  reset: () => void;
}

const DEFAULT_FEATURES: Record<Feature, boolean> = Object.values(Feature).reduce(
  (acc, f) => ({ ...acc, [f]: false }),
  {} as Record<Feature, boolean>
);

const DEFAULT_STATE = {
  tier: SubscriptionTier.FREE,
  features: DEFAULT_FEATURES,
  limits: { maxTeams: 3, maxSeasons: 1 },
  expiresAt: null,
  isLoaded: false,
};

export const useEntitlementsStore = create<EntitlementsState>()((set) => ({
  ...DEFAULT_STATE,

  fetchEntitlements: async () => {
    try {
      const { data } = await apiClient.get<Entitlements>('/auth/entitlements');
      set({
        tier: data.tier,
        features: data.features,
        limits: data.limits,
        expiresAt: data.expiresAt,
        isLoaded: true,
      });
    } catch {
      // On error, default to FREE tier
      set({ ...DEFAULT_STATE, isLoaded: true });
    }
  },

  reset: () => set(DEFAULT_STATE),
}));

/**
 * Selector: check if a specific feature is available
 */
export const useHasFeature = (feature: Feature) =>
  useEntitlementsStore((state) => state.features[feature]);

/**
 * Selector: get the current subscription tier
 */
export const useSubscriptionTier = () =>
  useEntitlementsStore((state) => state.tier);

/**
 * Selector: get usage limits
 */
export const useUsageLimits = () =>
  useEntitlementsStore((state) => state.limits);

/**
 * Setup listener to re-fetch entitlements when app comes to foreground
 */
export function setupEntitlementsRefresh(): () => void {
  const handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      useEntitlementsStore.getState().fetchEntitlements();
    }
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  return () => subscription.remove();
}
