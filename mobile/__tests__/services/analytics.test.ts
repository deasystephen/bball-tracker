/**
 * Tests for analytics service.
 *
 * Verifies:
 *   - initAnalytics is a no-op (does NOT call amplitude.init) when no API key
 *     is configured, and returns without throwing.
 *   - Before init, events are buffered and identity (user id + merged user
 *     properties) is held, then applied at init before the buffered events
 *     are sent (#647); both are dropped with no SDK call when there is no
 *     key or init fails, and resetUser clears the held identity.
 *   - After a successful init, they delegate to amplitude with the right
 *     args, and the typed props map (#616) is what reaches `track`.
 *   - Errors thrown by amplitude are swallowed (function still returns).
 *   - The pure helpers (`changedFields`, `screenViewFromSegments`) never leak
 *     a value or a path param.
 */

const mockAmplitude = {
  init: jest.fn(),
  track: jest.fn(),
  setUserId: jest.fn(),
  identify: jest.fn(),
  reset: jest.fn(),
  getUserId: jest.fn(),
  getDeviceId: jest.fn(),
  Identify: jest.fn().mockImplementation(() => ({
    set: jest.fn(),
  })),
};

jest.mock('@amplitude/analytics-react-native', () => mockAmplitude);

const mockExpoConstants: { expoConfig: { version?: string; extra: Record<string, unknown> } } = {
  expoConfig: { extra: {} },
};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockExpoConstants,
}));

/**
 * The module is read through `requireActual` at call time, not imported at
 * the top: a top-level import is hoisted above `mockAmplitude` and would run
 * the mock factory before that object exists.
 */
type AnalyticsModule = typeof import('../../services/analytics');

function load(): AnalyticsModule {
  return jest.requireActual<AnalyticsModule>('../../services/analytics');
}

function trackingOptions(): AnalyticsModule['AMPLITUDE_TRACKING_OPTIONS'] {
  return load().AMPLITUDE_TRACKING_OPTIONS;
}

/** What every sent event carries in its options: the identity at call time. */
const IDENTITY = { user_id: 'u1', device_id: 'd1' };

async function loadInitialized(): Promise<AnalyticsModule> {
  mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
  mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });
  mockAmplitude.getUserId.mockReturnValue('u1');
  mockAmplitude.getDeviceId.mockReturnValue('d1');
  const mod = load();
  await mod.initAnalytics();
  return mod;
}

describe('analytics service', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockExpoConstants.expoConfig = { extra: {} };
    // Analytics swallows errors and logs via console.warn in __DEV__.
    // Suppress that noise in tests.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('initAnalytics is a no-op when no API key is configured', async () => {
    const { initAnalytics, trackEvent, AnalyticsEvents } = load();
    await initAnalytics();
    expect(mockAmplitude.init).not.toHaveBeenCalled();

    // trackEvent is still safe (no-op) since we never initialized.
    trackEvent(AnalyticsEvents.APP_OPENED);
    expect(mockAmplitude.track).not.toHaveBeenCalled();
  });

  it('initAnalytics calls amplitude.init with the configured key and enables tracking', async () => {
    const { trackEvent, AnalyticsEvents } = await loadInitialized();

    expect(mockAmplitude.init).toHaveBeenCalledWith('test-key', undefined, {
      trackingOptions: trackingOptions(),
    });

    // After successful init, trackEvent should delegate.
    trackEvent(AnalyticsEvents.TEAM_DELETED, { team_id: 't1' });
    expect(mockAmplitude.track).toHaveBeenCalledWith('team_deleted', { team_id: 't1' }, IDENTITY);
  });

  describe('typed event catalogue (#616)', () => {
    it('sends an event without properties with `undefined` properties', async () => {
      const { trackEvent, AnalyticsEvents } = await loadInitialized();
      trackEvent(AnalyticsEvents.APP_OPENED);
      expect(mockAmplitude.track).toHaveBeenCalledWith('app_opened', undefined, IDENTITY);
    });

    it('passes the typed properties through untouched', async () => {
      const { trackEvent, AnalyticsEvents } = await loadInitialized();
      trackEvent(AnalyticsEvents.GAME_EVENT_RECORDED, {
        game_id: 'g1',
        event_type: 'SHOT',
        shot_made: true,
        shot_points: 3,
      });
      expect(mockAmplitude.track).toHaveBeenCalledWith(
        'game_event_recorded',
        { game_id: 'g1', event_type: 'SHOT', shot_made: true, shot_points: 3 },
        IDENTITY
      );
    });

    it('rejects an uncatalogued name and wrong properties at compile time', async () => {
      const { trackEvent, AnalyticsEvents } = await loadInitialized();
      // @ts-expect-error — only catalogued names are accepted (no `| string`).
      trackEvent('ad_hoc_event');
      // @ts-expect-error — team_deleted requires team_id.
      trackEvent(AnalyticsEvents.TEAM_DELETED);
      // @ts-expect-error — app_opened takes no properties.
      trackEvent(AnalyticsEvents.APP_OPENED, { foo: 1 });
      // @ts-expect-error — an unknown property is a glossary change, not a typo.
      trackEvent(AnalyticsEvents.TEAM_DELETED, { team_id: 't1', player_name: 'x' });
      expect(mockAmplitude.track).toHaveBeenCalledTimes(4);
    });

    it('every catalogued name is snake_case', () => {
      const { AnalyticsEvents } = load();
      for (const name of Object.values(AnalyticsEvents)) {
        expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      }
    });
  });

  describe('identity at call time', () => {
    it('stamps the user and device id the moment the event is tracked, so a following reset cannot steal it', async () => {
      const { trackEvent, resetUser, AnalyticsEvents } = await loadInitialized();
      // The real SDK clears these synchronously on reset(); the mock mirrors that.
      mockAmplitude.reset.mockImplementationOnce(() => {
        mockAmplitude.getUserId.mockReturnValue(undefined);
        mockAmplitude.getDeviceId.mockReturnValue('fresh-device');
      });

      trackEvent(AnalyticsEvents.USER_LOGGED_OUT, { reason: 'user' });
      resetUser();

      expect(mockAmplitude.track).toHaveBeenCalledWith('user_logged_out', { reason: 'user' }, IDENTITY);
      trackEvent(AnalyticsEvents.APP_OPENED);
      expect(mockAmplitude.track).toHaveBeenLastCalledWith('app_opened', undefined, { device_id: 'fresh-device' });
    });

    it('sends no identity fields when the SDK has none yet', async () => {
      const { trackEvent, AnalyticsEvents } = await loadInitialized();
      mockAmplitude.getUserId.mockReturnValue(undefined);
      mockAmplitude.getDeviceId.mockReturnValue(undefined);
      trackEvent(AnalyticsEvents.APP_OPENED);
      expect(mockAmplitude.track).toHaveBeenCalledWith('app_opened', undefined, {});
    });
  });

  describe('events before init', () => {
    it('are held and sent in order once init succeeds (the launch screen_viewed is not lost)', async () => {
      mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
      mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });
      mockAmplitude.getDeviceId.mockReturnValue('d1');
      const { initAnalytics, trackEvent, AnalyticsEvents } = load();

      trackEvent(AnalyticsEvents.SCREEN_VIEWED, { screen: '/', params_kind: 'none' });
      trackEvent(AnalyticsEvents.SCREEN_VIEWED, { screen: '/(tabs)/home', params_kind: 'none' });
      expect(mockAmplitude.track).not.toHaveBeenCalled();

      await initAnalytics();
      expect(mockAmplitude.track.mock.calls.map((call) => call[1])).toEqual([
        { screen: '/', params_kind: 'none' },
        { screen: '/(tabs)/home', params_kind: 'none' },
      ]);
    });

    it('are dropped when there is no key, and when init fails', async () => {
      const first = load();
      first.trackEvent(first.AnalyticsEvents.APP_OPENED);
      await first.initAnalytics();
      expect(mockAmplitude.track).not.toHaveBeenCalled();
      // After the decision nothing is buffered either.
      first.trackEvent(first.AnalyticsEvents.APP_OPENED);
      expect(mockAmplitude.track).not.toHaveBeenCalled();

      jest.resetModules();
      mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
      mockAmplitude.init.mockReturnValueOnce({ promise: Promise.reject(new Error('boom')) });
      const second = load();
      second.trackEvent(second.AnalyticsEvents.APP_OPENED);
      await second.initAnalytics();
      expect(mockAmplitude.track).not.toHaveBeenCalled();
    });

    it('keep only the newest PRE_INIT_BUFFER_LIMIT events', async () => {
      mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
      mockAmplitude.init.mockReturnValueOnce({ promise: Promise.resolve() });
      const { initAnalytics, trackEvent, AnalyticsEvents, PRE_INIT_BUFFER_LIMIT } = load();
      for (let i = 0; i < PRE_INIT_BUFFER_LIMIT + 5; i++) {
        trackEvent(AnalyticsEvents.SCREEN_VIEWED, { screen: `/s${i}`, params_kind: 'none' });
      }
      await initAnalytics();
      expect(mockAmplitude.track).toHaveBeenCalledTimes(PRE_INIT_BUFFER_LIMIT);
      expect(mockAmplitude.track.mock.calls[0][1]).toEqual({ screen: '/s5', params_kind: 'none' });
    });
  });

  describe('identity before init (#647)', () => {
    /** The SDK mock remembers the user id it was given, like the real client. */
    function rememberUserId(): void {
      let userId: string | undefined;
      mockAmplitude.setUserId.mockImplementation((id: string) => {
        userId = id;
      });
      mockAmplitude.getUserId.mockImplementation(() => userId);
      mockAmplitude.getDeviceId.mockReturnValue('d1');
    }

    function withKey(promise: Promise<void> = Promise.resolve()): AnalyticsModule {
      mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
      mockAmplitude.init.mockReturnValueOnce({ promise });
      return load();
    }

    afterEach(() => {
      mockAmplitude.setUserId.mockReset();
      mockAmplitude.getUserId.mockReset();
    });

    it('identifyUser before init is applied at init, before any buffered event is sent', async () => {
      rememberUserId();
      const set = jest.fn();
      mockAmplitude.Identify.mockImplementationOnce(() => ({ set }));
      const { initAnalytics, identifyUser, trackEvent, AnalyticsEvents } = withKey();

      identifyUser('user-1', { role: 'COACH', is_parent: false });
      trackEvent(AnalyticsEvents.USER_LOGGED_IN);
      expect(mockAmplitude.setUserId).not.toHaveBeenCalled();
      expect(mockAmplitude.identify).not.toHaveBeenCalled();

      await initAnalytics();
      expect(mockAmplitude.setUserId).toHaveBeenCalledTimes(1);
      expect(mockAmplitude.setUserId).toHaveBeenCalledWith('user-1');
      expect(mockAmplitude.identify).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith('role', 'COACH');
      expect(set).toHaveBeenCalledWith('is_parent', false);

      const trackOrder = mockAmplitude.track.mock.invocationCallOrder[0];
      expect(mockAmplitude.setUserId.mock.invocationCallOrder[0]).toBeLessThan(trackOrder);
      expect(mockAmplitude.identify.mock.invocationCallOrder[0]).toBeLessThan(trackOrder);
    });

    it('flushes the buffered user_logged_in with the pending user id', async () => {
      rememberUserId();
      const { initAnalytics, identifyUser, trackEvent, AnalyticsEvents } = withKey();

      identifyUser('user-1');
      trackEvent(AnalyticsEvents.USER_LOGGED_IN);
      await initAnalytics();

      expect(mockAmplitude.track).toHaveBeenCalledWith('user_logged_in', undefined, {
        user_id: 'user-1',
        device_id: 'd1',
      });
    });

    it('merges setUserProperties partials (later keys win, undefined skipped) and applies them once', async () => {
      const set = jest.fn();
      mockAmplitude.Identify.mockImplementationOnce(() => ({ set }));
      const { initAnalytics, identifyUser, setUserProperties } = withKey();

      identifyUser('user-1', { role: 'PLAYER', tier: 'FREE' });
      setUserProperties({ tier: 'PREMIUM', team_count: 3 });
      setUserProperties({ team_count: undefined, role: undefined });
      await initAnalytics();

      expect(mockAmplitude.identify).toHaveBeenCalledTimes(1);
      expect(set.mock.calls).toEqual(
        expect.arrayContaining([
          ['role', 'PLAYER'],
          ['tier', 'PREMIUM'],
          ['team_count', 3],
        ]),
      );
      expect(set).toHaveBeenCalledTimes(3);
    });

    it('setUserProperties alone before init applies the properties without a user id', async () => {
      const { initAnalytics, setUserProperties } = withKey();
      setUserProperties({ tier: 'FREE' });
      expect(mockAmplitude.identify).not.toHaveBeenCalled();

      await initAnalytics();
      expect(mockAmplitude.setUserId).not.toHaveBeenCalled();
      expect(mockAmplitude.identify).toHaveBeenCalledTimes(1);
    });

    it('resetUser before init clears the pending identity; nothing is applied at init', async () => {
      const { initAnalytics, identifyUser, setUserProperties, resetUser } = withKey();

      identifyUser('user-1', { role: 'COACH' });
      setUserProperties({ tier: 'FREE' });
      resetUser();
      await initAnalytics();

      expect(mockAmplitude.setUserId).not.toHaveBeenCalled();
      expect(mockAmplitude.identify).not.toHaveBeenCalled();
      expect(mockAmplitude.reset).not.toHaveBeenCalled();
    });

    it('is dropped with no SDK call when there is no API key', async () => {
      const { initAnalytics, identifyUser, setUserProperties, resetUser } = load();
      identifyUser('user-1', { role: 'COACH' });
      setUserProperties({ tier: 'FREE' });
      await initAnalytics();
      // After the decision nothing is held either.
      identifyUser('user-2', { role: 'PLAYER' });
      setUserProperties({ tier: 'PREMIUM' });
      resetUser();

      expect(mockAmplitude.init).not.toHaveBeenCalled();
      expect(mockAmplitude.setUserId).not.toHaveBeenCalled();
      expect(mockAmplitude.identify).not.toHaveBeenCalled();
      expect(mockAmplitude.reset).not.toHaveBeenCalled();
    });

    it('is dropped with no SDK call when amplitude.init rejects', async () => {
      const { initAnalytics, identifyUser, setUserProperties } = withKey(
        Promise.reject(new Error('boom')),
      );
      identifyUser('user-1', { role: 'COACH' });
      setUserProperties({ tier: 'FREE' });
      await initAnalytics();
      identifyUser('user-2');
      setUserProperties({ tier: 'PREMIUM' });

      expect(mockAmplitude.setUserId).not.toHaveBeenCalled();
      expect(mockAmplitude.identify).not.toHaveBeenCalled();
    });
  });

  // Tracking options (#559). These values are what the App Privacy labels and
  // the data-subject runbook declare, so a change here is a change to what the
  // app tells Apple and its users. Update docs/release/app-store-submission.md
  // and docs/runbooks/data-subject-requests.md in the same change.
  describe('tracking options', () => {
    it('never falls back to the SDK defaults', async () => {
      await loadInitialized();

      const options = mockAmplitude.init.mock.calls[0][2] as { trackingOptions?: unknown };
      expect(options?.trackingOptions).toBeDefined();
    });

    it('keeps the IP address on, for city and country, and the advertising id off', () => {
      expect(trackingOptions().ipAddress).toBe(true);
      expect(trackingOptions().adid).toBe(false);
    });

    it('leaves the device-reported country off, which would disable the IP lookup', () => {
      expect(trackingOptions().country).toBe(false);
    });

    it('pins the full set that the privacy labels declare', () => {
      expect(trackingOptions()).toEqual({
        adid: false,
        appSetId: true,
        carrier: true,
        country: false,
        deviceManufacturer: true,
        deviceModel: true,
        idfv: true,
        ipAddress: true,
        language: true,
        osName: true,
        osVersion: true,
        platform: true,
      });
    });

    it('decides every option the installed SDK has, so an upgrade cannot add one silently', () => {
      const { getDefaultConfig } = jest.requireActual<{
        getDefaultConfig: () => { trackingOptions: Record<string, boolean> };
      }>('@amplitude/analytics-react-native/lib/commonjs/config');

      const sdkOptions = Object.keys(getDefaultConfig().trackingOptions);

      expect(Object.keys(trackingOptions()).sort()).toEqual(sdkOptions.sort());
    });
  });

  it('initAnalytics swallows errors from amplitude.init', async () => {
    mockExpoConstants.expoConfig.extra = { amplitudeApiKey: 'test-key' };
    mockAmplitude.init.mockReturnValueOnce({ promise: Promise.reject(new Error('boom')) });

    const { initAnalytics, trackEvent, AnalyticsEvents } = load();
    await expect(initAnalytics()).resolves.toBeUndefined();

    // Since init failed, tracking should remain a no-op.
    trackEvent(AnalyticsEvents.APP_OPENED);
    expect(mockAmplitude.track).not.toHaveBeenCalled();
  });

  describe('user properties (#616)', () => {
    it('identifyUser sets user id and applies properties via Identify', async () => {
      const { identifyUser } = await loadInitialized();
      const set = jest.fn();
      mockAmplitude.Identify.mockImplementationOnce(() => ({ set }));

      identifyUser('user-1', { role: 'COACH', is_parent: false, team_count: 2 });
      expect(mockAmplitude.setUserId).toHaveBeenCalledWith('user-1');
      expect(set).toHaveBeenCalledWith('role', 'COACH');
      expect(set).toHaveBeenCalledWith('is_parent', false);
      expect(set).toHaveBeenCalledWith('team_count', 2);
      expect(mockAmplitude.identify).toHaveBeenCalledTimes(1);
    });

    it('identifyUser without properties only sets user id', async () => {
      const { identifyUser } = await loadInitialized();

      identifyUser('user-2');
      expect(mockAmplitude.setUserId).toHaveBeenCalledWith('user-2');
      expect(mockAmplitude.identify).not.toHaveBeenCalled();
    });

    it('setUserProperties refreshes without touching the user id and skips undefined', async () => {
      const { setUserProperties } = await loadInitialized();
      const set = jest.fn();
      mockAmplitude.Identify.mockImplementationOnce(() => ({ set }));

      setUserProperties({ tier: 'FREE', team_count: undefined });
      expect(mockAmplitude.setUserId).not.toHaveBeenCalled();
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith('tier', 'FREE');
      expect(mockAmplitude.identify).toHaveBeenCalledTimes(1);
    });

    it('setUserProperties with nothing to set sends no identify call', async () => {
      const { setUserProperties } = await loadInitialized();
      setUserProperties({ tier: undefined });
      expect(mockAmplitude.identify).not.toHaveBeenCalled();
    });

    it('appVersion reads the binary version from expo config', () => {
      mockExpoConstants.expoConfig.version = '1.5.0';
      expect(load().appVersion()).toBe('1.5.0');
      delete mockExpoConstants.expoConfig.version;
      expect(load().appVersion()).toBe('unknown');
    });
  });

  it('resetUser delegates to amplitude.reset once initialized', async () => {
    const { resetUser } = await loadInitialized();

    resetUser();
    expect(mockAmplitude.reset).toHaveBeenCalled();
  });

  it('swallows amplitude errors thrown from trackEvent / identifyUser / setUserProperties / resetUser', async () => {
    const { trackEvent, identifyUser, setUserProperties, resetUser, AnalyticsEvents } = await loadInitialized();

    mockAmplitude.track.mockImplementationOnce(() => {
      throw new Error('track-fail');
    });
    mockAmplitude.setUserId.mockImplementationOnce(() => {
      throw new Error('identify-fail');
    });
    mockAmplitude.identify.mockImplementationOnce(() => {
      throw new Error('props-fail');
    });
    mockAmplitude.reset.mockImplementationOnce(() => {
      throw new Error('reset-fail');
    });

    expect(() => trackEvent(AnalyticsEvents.APP_OPENED)).not.toThrow();
    expect(() => identifyUser('u')).not.toThrow();
    expect(() => setUserProperties({ tier: 'FREE' })).not.toThrow();
    expect(() => resetUser()).not.toThrow();
  });

  describe('changedFields', () => {
    it('names the keys that were sent, sorted, and never their values', () => {
      const { changedFields } = load();
      expect(changedFields({ status: 'FINISHED', opponent: 'Lakers' })).toBe('opponent,status');
      expect(changedFields({ name: undefined, chatLink: null })).toBe('chatLink');
      expect(changedFields(undefined)).toBe('');
    });
  });

  describe('screenViewFromSegments', () => {
    it('sends the route pattern and names the params, never the values', () => {
      const { screenViewFromSegments } = load();
      expect(screenViewFromSegments(['teams', '[id]'])).toEqual({ screen: '/teams/[id]', params_kind: 'id' });
      expect(screenViewFromSegments(['teams', '[id]', 'players', '[playerId]', 'guardians'])).toEqual({
        screen: '/teams/[id]/players/[playerId]/guardians',
        params_kind: 'id,playerId',
      });
      expect(screenViewFromSegments(['invite', '[token]'])).toEqual({ screen: '/invite/[token]', params_kind: 'token' });
      expect(screenViewFromSegments(['[...missing]'])).toEqual({ screen: '/[...missing]', params_kind: 'missing' });
    });

    it('marks a static route as having no params', () => {
      const { screenViewFromSegments } = load();
      expect(screenViewFromSegments(['(tabs)', 'home'])).toEqual({ screen: '/(tabs)/home', params_kind: 'none' });
      expect(screenViewFromSegments([])).toEqual({ screen: '/', params_kind: 'none' });
    });
  });
});
