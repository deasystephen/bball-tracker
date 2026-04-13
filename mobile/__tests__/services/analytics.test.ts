/**
 * Tests for analytics service.
 *
 * Verifies:
 *   - initAnalytics is a no-op (does NOT call amplitude.init) when no API key
 *     is configured, and returns without throwing.
 *   - trackEvent / identifyUser / resetUser are no-ops before init (guarded
 *     by the `initialized` flag).
 *   - After a successful init, trackEvent / identifyUser / resetUser
 *     delegate to amplitude with the right args.
 *   - Errors thrown by amplitude are swallowed (function still returns).
 */

const mockAmplitude = {
  init: jest.fn(),
  track: jest.fn(),
  setUserId: jest.fn(),
  identify: jest.fn(),
  reset: jest.fn(),
  Identify: jest.fn().mockImplementation(() => ({
    set: jest.fn(),
  })),
};

jest.mock('@amplitude/analytics-react-native', () => mockAmplitude);

const mockExpoConstants: { expoConfig: { extra: Record<string, unknown> } } = {
  expoConfig: { extra: {} },
};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockExpoConstants,
}));

describe('analytics service', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockExpoConstants.expoConfig.extra = {};
    // Analytics swallows errors and logs via console.warn in __DEV__.
    // Suppress that noise in tests.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('initAnalytics is a no-op when no API key is configured', async () => {
    const { initAnalytics, trackEvent } = require('../../services/analytics');
    await initAnalytics();
    expect(mockAmplitude.init).not.toHaveBeenCalled();

    // trackEvent is still safe (no-op) since we never initialized.
    trackEvent('any_event');
    expect(mockAmplitude.track).not.toHaveBeenCalled();
  });

  it('initAnalytics calls amplitude.init with the configured key and enables tracking', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });

    const { initAnalytics, trackEvent } = require('../../services/analytics');
    await initAnalytics();

    expect(mockAmplitude.init).toHaveBeenCalledWith('test-key');

    // After successful init, trackEvent should delegate.
    trackEvent('evt', { foo: 1 });
    expect(mockAmplitude.track).toHaveBeenCalledWith('evt', { foo: 1 });
  });

  it('initAnalytics swallows errors from amplitude.init', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.reject(new Error('boom')) });

    const { initAnalytics, trackEvent } = require('../../services/analytics');
    await expect(initAnalytics()).resolves.toBeUndefined();

    // Since init failed, tracking should remain a no-op.
    trackEvent('evt');
    expect(mockAmplitude.track).not.toHaveBeenCalled();
  });

  it('identifyUser sets user id and applies properties via Identify', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });

    const { initAnalytics, identifyUser } = require('../../services/analytics');
    await initAnalytics();

    identifyUser('user-1', { plan: 'pro' });
    expect(mockAmplitude.setUserId).toHaveBeenCalledWith('user-1');
    expect(mockAmplitude.Identify).toHaveBeenCalled();
    expect(mockAmplitude.identify).toHaveBeenCalled();
  });

  it('identifyUser without properties only sets user id', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });

    const { initAnalytics, identifyUser } = require('../../services/analytics');
    await initAnalytics();

    identifyUser('user-2');
    expect(mockAmplitude.setUserId).toHaveBeenCalledWith('user-2');
    expect(mockAmplitude.identify).not.toHaveBeenCalled();
  });

  it('resetUser delegates to amplitude.reset once initialized', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });

    const { initAnalytics, resetUser } = require('../../services/analytics');
    await initAnalytics();

    resetUser();
    expect(mockAmplitude.reset).toHaveBeenCalled();
  });

  it('swallows amplitude errors thrown from trackEvent / identifyUser / resetUser', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });

    const { initAnalytics, trackEvent, identifyUser, resetUser } = require('../../services/analytics');
    await initAnalytics();

    mockAmplitude.track.mockImplementationOnce(() => {
      throw new Error('track-fail');
    });
    mockAmplitude.setUserId.mockImplementationOnce(() => {
      throw new Error('identify-fail');
    });
    mockAmplitude.reset.mockImplementationOnce(() => {
      throw new Error('reset-fail');
    });

    expect(() => trackEvent('e')).not.toThrow();
    expect(() => identifyUser('u')).not.toThrow();
    expect(() => resetUser()).not.toThrow();
  });
});
