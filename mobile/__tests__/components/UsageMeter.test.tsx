/**
 * Tests for UsageMeter.
 *
 * The API caps no tier since #445, so `GET /auth/me/usage` reports
 * `limit: null` / `limitReached: false` for every metric. The meter must
 * degrade to a plain count: no "N of M", no progress bar, no upgrade CTA.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { UsageMeter } from '../../components/UsageMeter';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      text: '#000000',
      textSecondary: '#666666',
      error: '#FF0000',
      primary: '#0000FF',
      accent: '#FF8800',
      border: '#E5E5E5',
    },
    isDark: false,
  }),
}));

const UPGRADE_HINT = 'Upgrade for unlimited';

describe('UsageMeter', () => {
  describe('unlimited (limit: null) — what every tier reports today', () => {
    it('renders the count as unlimited, with no upgrade CTA', () => {
      const { getByText, queryByText } = render(
        <UsageMeter
          label="Teams"
          metric={{ count: 4, limit: null, limitReached: false }}
          upgradeHint={UPGRADE_HINT}
        />
      );

      expect(getByText('Teams')).toBeTruthy();
      expect(getByText('4 · Unlimited')).toBeTruthy();
      expect(queryByText(/ of /)).toBeNull();
      expect(queryByText(UPGRADE_HINT)).toBeNull();
    });

    it('renders a zero count without dividing by the missing limit', () => {
      const { getByText, queryByText } = render(
        <UsageMeter
          label="Teams"
          metric={{ count: 0, limit: null, limitReached: false }}
          upgradeHint={UPGRADE_HINT}
        />
      );

      expect(getByText('0 · Unlimited')).toBeTruthy();
      expect(queryByText(/NaN|Infinity|null/)).toBeNull();
    });
  });

  describe('finite limit — only when the API reports one', () => {
    it('renders "count of limit" without the CTA while under the limit', () => {
      const { getByText, queryByText } = render(
        <UsageMeter
          label="Teams"
          metric={{ count: 2, limit: 3, limitReached: false }}
          upgradeHint={UPGRADE_HINT}
        />
      );

      expect(getByText('2 of 3')).toBeTruthy();
      expect(queryByText(UPGRADE_HINT)).toBeNull();
    });

    it('shows the CTA once the limit is reached', () => {
      const { getByText } = render(
        <UsageMeter
          label="Teams"
          metric={{ count: 3, limit: 3, limitReached: true }}
          upgradeHint={UPGRADE_HINT}
        />
      );

      expect(getByText('3 of 3')).toBeTruthy();
      expect(getByText(UPGRADE_HINT)).toBeTruthy();
    });
  });
});
