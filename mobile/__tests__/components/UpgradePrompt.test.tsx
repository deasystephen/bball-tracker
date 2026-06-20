/**
 * Tests for UpgradePrompt.
 *
 * Covers tier label rendering, optional description, and the upgrade CTA text.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import { UpgradePrompt } from '../../components/UpgradePrompt';
import { SubscriptionTier } from '../../../shared/types';

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

describe('UpgradePrompt', () => {
  it('renders the required tier label and upgrade CTA', () => {
    const { getByText } = render(
      <UpgradePrompt requiredTier={SubscriptionTier.PREMIUM} />
    );
    expect(getByText('Premium Feature')).toBeTruthy();
    expect(getByText('Upgrade to Premium')).toBeTruthy();
  });

  it('renders the LEAGUE tier label', () => {
    const { getByText } = render(
      <UpgradePrompt requiredTier={SubscriptionTier.LEAGUE} />
    );
    expect(getByText('League Feature')).toBeTruthy();
    expect(getByText('Upgrade to League')).toBeTruthy();
  });

  it('renders the feature description when provided', () => {
    const { getByText } = render(
      <UpgradePrompt
        requiredTier={SubscriptionTier.PREMIUM}
        featureDescription="Export your stats to CSV"
      />
    );
    expect(getByText('Export your stats to CSV')).toBeTruthy();
  });

  it('omits the description when not provided', () => {
    const { queryByText } = render(
      <UpgradePrompt requiredTier={SubscriptionTier.PREMIUM} />
    );
    expect(queryByText('Export your stats to CSV')).toBeNull();
  });
});
