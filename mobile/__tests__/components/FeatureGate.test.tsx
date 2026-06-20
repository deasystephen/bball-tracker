/**
 * Tests for FeatureGate.
 *
 * Covers: renders children when the user has the feature, renders the default
 * UpgradePrompt fallback when they don't, and renders a custom fallback when one
 * is supplied.
 */

import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

import { FeatureGate } from '../../components/FeatureGate';
import { Feature, SubscriptionTier } from '../../../shared/types';

const mockUseHasFeature = jest.fn();

jest.mock('../../store/entitlements-store', () => ({
  useHasFeature: (feature: Feature) => mockUseHasFeature(feature),
}));

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      backgroundTertiary: '#eee',
      border: '#ccc',
      accent: '#F50',
      textSecondary: '#666',
      textInverse: '#fff',
    },
    colorScheme: 'light',
  }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

describe('FeatureGate', () => {
  beforeEach(() => mockUseHasFeature.mockReset());

  it('renders children when the user has access', () => {
    mockUseHasFeature.mockReturnValue(true);
    const { getByText, queryByText } = render(
      <FeatureGate feature={Feature.STATS_EXPORT} requiredTier={SubscriptionTier.PREMIUM}>
        <Text>Premium content</Text>
      </FeatureGate>
    );
    expect(getByText('Premium content')).toBeTruthy();
    expect(queryByText('Upgrade to Premium')).toBeNull();
  });

  it('renders the default UpgradePrompt when the user lacks access', () => {
    mockUseHasFeature.mockReturnValue(false);
    const { getByText, queryByText } = render(
      <FeatureGate feature={Feature.STATS_EXPORT} requiredTier={SubscriptionTier.PREMIUM}>
        <Text>Premium content</Text>
      </FeatureGate>
    );
    expect(queryByText('Premium content')).toBeNull();
    expect(getByText('Upgrade to Premium')).toBeTruthy();
  });

  it('renders a custom fallback when one is provided and access is denied', () => {
    mockUseHasFeature.mockReturnValue(false);
    const { getByText, queryByText } = render(
      <FeatureGate
        feature={Feature.STATS_EXPORT}
        requiredTier={SubscriptionTier.PREMIUM}
        fallback={<Text>Custom fallback</Text>}
      >
        <Text>Premium content</Text>
      </FeatureGate>
    );
    expect(getByText('Custom fallback')).toBeTruthy();
    expect(queryByText('Upgrade to Premium')).toBeNull();
  });
});
