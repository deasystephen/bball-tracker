/**
 * `trackAppOpened` (#967): `app_opened` says which JavaScript is running, and
 * every launch refreshes the build user properties (a rehydrated session never
 * runs `setUser`, so they would otherwise stay on the OTA of the last sign-in).
 */

import { trackAppOpened } from '../../services/app-opened';
import { trackEvent, setUserProperties } from '../../services/analytics';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
  setUserProperties: jest.fn(),
}));

const UPDATE_ID = '01a15220-8b6d-7172-a9a5-2d5fce7c6954';

describe('trackAppOpened (#967)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the running OTA and refreshes the build user properties', () => {
    trackAppOpened({ appVersion: '1.6.0', launch: 'update', updateId: UPDATE_ID, runtimeVersion: '1.6.0' });

    expect(trackEvent).toHaveBeenCalledWith('app_opened', {
      launch: 'update',
      update_id: UPDATE_ID,
      runtime_version: '1.6.0',
    });
    expect(setUserProperties).toHaveBeenCalledWith({ app_version: '1.6.0', update_id: UPDATE_ID });
  });

  it('sends a null update id on the event and "embedded" on the user for the bundled JS', () => {
    trackAppOpened({ appVersion: '1.6.0', launch: 'embedded', updateId: null, runtimeVersion: '1.6.0' });

    expect(trackEvent).toHaveBeenCalledWith('app_opened', {
      launch: 'embedded',
      update_id: null,
      runtime_version: '1.6.0',
    });
    expect(setUserProperties).toHaveBeenCalledWith({ app_version: '1.6.0', update_id: 'embedded' });
  });

  it('reads the running build when not given one (no ExpoUpdates module in Jest: embedded)', () => {
    trackAppOpened();
    expect((trackEvent as jest.Mock).mock.calls[0][1]).toMatchObject({ launch: 'embedded', update_id: null });
  });
});
