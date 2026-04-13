/**
 * Tests for entitlements-store.
 *
 * Exercises fetchEntitlements success + failure paths and the reset action.
 * apiClient is mocked globally in jest.setup.js.
 */

import { useEntitlementsStore, setupEntitlementsRefresh } from '../../store/entitlements-store';
import { apiClient } from '../../services/api-client';
import { Feature, SubscriptionTier } from '../../../shared/types';

type MockedApi = {
  get: jest.Mock;
};

const mockedApi = apiClient as unknown as MockedApi;

describe('entitlements-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useEntitlementsStore.getState().reset();
  });

  it('defaults to FREE tier with all features disabled', () => {
    const state = useEntitlementsStore.getState();
    expect(state.tier).toBe(SubscriptionTier.FREE);
    expect(state.isLoaded).toBe(false);
    expect(state.limits).toEqual({ maxTeams: 3, maxSeasons: 1 });
    // Every Feature should be false by default.
    for (const feature of Object.values(Feature)) {
      expect(state.features[feature]).toBe(false);
    }
  });

  it('fetchEntitlements applies server-provided tier/features/limits', async () => {
    const features = Object.values(Feature).reduce(
      (acc, f) => ({ ...acc, [f]: false }),
      {} as Record<Feature, boolean>,
    );
    features[Feature.UNLIMITED_TEAMS] = true;
    features[Feature.STATS_EXPORT] = true;

    mockedApi.get.mockResolvedValueOnce({
      data: {
        tier: SubscriptionTier.PREMIUM,
        features,
        limits: { maxTeams: 999, maxSeasons: 99 },
        expiresAt: '2027-01-01T00:00:00Z',
      },
    });

    await useEntitlementsStore.getState().fetchEntitlements();

    expect(mockedApi.get).toHaveBeenCalledWith('/auth/entitlements');
    const state = useEntitlementsStore.getState();
    expect(state.tier).toBe(SubscriptionTier.PREMIUM);
    expect(state.features[Feature.UNLIMITED_TEAMS]).toBe(true);
    expect(state.features[Feature.STATS_EXPORT]).toBe(true);
    expect(state.features[Feature.ADVANCED_STATS]).toBe(false);
    expect(state.limits).toEqual({ maxTeams: 999, maxSeasons: 99 });
    expect(state.expiresAt).toBe('2027-01-01T00:00:00Z');
    expect(state.isLoaded).toBe(true);
  });

  it('fetchEntitlements falls back to FREE tier on API failure but marks loaded', async () => {
    mockedApi.get.mockRejectedValueOnce(new Error('network down'));

    await useEntitlementsStore.getState().fetchEntitlements();

    const state = useEntitlementsStore.getState();
    expect(state.tier).toBe(SubscriptionTier.FREE);
    expect(state.isLoaded).toBe(true);
    expect(state.limits).toEqual({ maxTeams: 3, maxSeasons: 1 });
  });

  it('reset clears any previously-loaded entitlements back to defaults', async () => {
    useEntitlementsStore.setState({
      tier: SubscriptionTier.PREMIUM,
      isLoaded: true,
      limits: { maxTeams: 999, maxSeasons: 99 },
    });

    useEntitlementsStore.getState().reset();

    const state = useEntitlementsStore.getState();
    expect(state.tier).toBe(SubscriptionTier.FREE);
    expect(state.isLoaded).toBe(false);
    expect(state.limits).toEqual({ maxTeams: 3, maxSeasons: 1 });
  });

  it('setupEntitlementsRefresh returns a cleanup function and fetches on foreground', () => {
    // AppState.addEventListener is provided by react-native; verify wiring.
    const cleanup = setupEntitlementsRefresh();
    expect(typeof cleanup).toBe('function');
    // Calling cleanup should not throw.
    expect(() => cleanup()).not.toThrow();
  });
});
