import React from 'react';
import { render } from '@testing-library/react-native';

import { StatRow } from '../../../components/stats/StatRow';

describe('StatRow', () => {
  it('renders label and value', () => {
    const { getByText } = render(<StatRow label="Points" value={24} />);
    expect(getByText('Points')).toBeTruthy();
    expect(getByText('24')).toBeTruthy();
  });

  it('renders string values', () => {
    const { getByText } = render(<StatRow label="Record" value="10-2" />);
    expect(getByText('10-2')).toBeTruthy();
    expect(getByText('Record')).toBeTruthy();
  });

  it('renders optional subtitle when provided', () => {
    const { getByText } = render(
      <StatRow label="Points" value={24} subtitle="per game" />
    );
    expect(getByText('per game')).toBeTruthy();
  });

  it('omits subtitle element when not provided', () => {
    const { queryByText } = render(<StatRow label="Points" value={24} />);
    expect(queryByText('per game')).toBeNull();
  });

  it('renders with each size variant without crashing', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const { getByText } = render(
        <StatRow label="PTS" value={10} size={size} />
      );
      expect(getByText('PTS')).toBeTruthy();
      expect(getByText('10')).toBeTruthy();
    }
  });
});
