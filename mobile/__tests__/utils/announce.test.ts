/**
 * utils/announce (#774): the single wrapper around the screen-reader
 * announcement API. Queued so a score change and the undo window are both
 * heard; never throws into a render.
 */

import { AccessibilityInfo } from 'react-native';

import { announce } from '../../utils/announce';
import { log } from '../../services/log';

describe('announce', () => {
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

  it('queues the message behind any announcement in progress', () => {
    announce('Score: Warriors 2, Rivals 0');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Score: Warriors 2, Rivals 0', { queue: true });
  });

  it('skips an empty message', () => {
    announce('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows a native failure and logs it without the message', () => {
    spy.mockImplementation(() => {
      throw new Error('no native module');
    });
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);

    expect(() => announce('Jamie Lee - 2PT Made')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('Jamie');
  });
});
