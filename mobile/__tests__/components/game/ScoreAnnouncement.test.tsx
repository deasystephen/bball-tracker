/**
 * Score announcements (#774) on the tracker's ScoreDisplay: one accessible,
 * labelled score element with a polite live region (TalkBack), and a spoken
 * update on iOS when either score changes, never on mount.
 */

import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { render } from '@testing-library/react-native';

import { ScoreDisplay } from '../../../components/game/ScoreDisplay';

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { success: '#0A0', error: '#A00' },
    colorScheme: 'light',
  }),
}));

const props = { homeTeamName: 'Hawks', awayTeamName: 'Bulls', homeScore: 10, awayScore: 8 };

describe('ScoreDisplay announcements', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => undefined);
    // React Native's Jest setup already mocks this API; spyOn returns that
    // mock, so clear the calls a previous test left on it.
    spy.mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('labels the score row as one element with a polite live region', () => {
    const { getByLabelText } = render(<ScoreDisplay {...props} />);
    const row = getByLabelText('Score: Hawks 10, Bulls 8');
    expect(row.props.accessible).toBe(true);
    expect(row.props.accessibilityLiveRegion).toBe('polite');
  });

  it('does not announce on mount', () => {
    render(<ScoreDisplay {...props} />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('announces the combined score once per change of either score', () => {
    const { rerender } = render(<ScoreDisplay {...props} />);

    rerender(<ScoreDisplay {...props} homeScore={12} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith('Score: Hawks 12, Bulls 8', { queue: true });

    rerender(<ScoreDisplay {...props} homeScore={12} awayScore={11} />);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('Score: Hawks 12, Bulls 11', { queue: true });

    // A re-render with the same score says nothing.
    rerender(<ScoreDisplay {...props} homeScore={12} awayScore={11} />);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not announce a team rename', () => {
    const { rerender } = render(<ScoreDisplay {...props} />);
    rerender(<ScoreDisplay {...props} awayTeamName="Chicago" />);
    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves Android to the live region so TalkBack hears each change once', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const { rerender } = render(<ScoreDisplay {...props} />);
    rerender(<ScoreDisplay {...props} homeScore={13} />);
    expect(spy).not.toHaveBeenCalled();
  });
});
