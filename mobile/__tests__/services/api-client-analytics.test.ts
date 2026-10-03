/**
 * Analytics the api-client emits (#616): `entitlement_denied` for every 402
 * the normalizer sees, and `error_shown` whenever a screen asks for the
 * message to show (`getApiErrorMessage`). Both carry the route pattern, the
 * code and the status only: never the message, which can quote user data,
 * and never an id.
 */

import { trackEvent } from '../../services/analytics';
import { normalizeApiError, getApiErrorMessage } from '../../services/api-client';

jest.unmock('../../services/api-client');

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
}));

jest.mock('../../store/auth-store', () => ({
  __esModule: true,
  getLogoutEpoch: () => 0,
  useAuthStore: { getState: () => ({ accessToken: null, clearSession: () => undefined }) },
}));

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  trackEvent: jest.fn(),
}));

const mockedTrack = trackEvent as jest.Mock;

const TEAM_ID = '4f1c2e3a-0000-4000-8000-000000000001';

function axiosError(status: number | undefined, data?: unknown, url = `/teams/${TEAM_ID}/players`) {
  return {
    isAxiosError: true,
    message: 'Request failed',
    config: { url, baseURL: 'https://example.test/api/v1', method: 'post' },
    response: status === undefined ? undefined : { status, data },
    code: status === undefined ? 'ECONNABORTED' : undefined,
  };
}

describe('api-client analytics', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('entitlement_denied', () => {
    it('fires on a 402 with the feature, the tiers and the id-free route pattern', () => {
      normalizeApiError(
        axiosError(402, {
          error: 'Upgrade required',
          code: 'upgrade_required',
          feature: 'teams',
          currentTier: 'FREE',
          requiredTier: 'PREMIUM',
        }, '/teams')
      );
      expect(mockedTrack).toHaveBeenCalledWith('entitlement_denied', {
        endpoint_pattern: '/api/v1/teams',
        feature: 'teams',
        current_tier: 'FREE',
        required_tier: 'PREMIUM',
      });
    });

    it('fires on the code alone and falls back to unknown for missing details', () => {
      normalizeApiError(axiosError(403, { error: 'x', code: 'upgrade_required' }));
      expect(mockedTrack).toHaveBeenCalledWith('entitlement_denied', {
        endpoint_pattern: '/api/v1/teams/:id/players',
        feature: 'unknown',
        current_tier: 'unknown',
        required_tier: 'unknown',
      });
      expect(JSON.stringify(mockedTrack.mock.calls)).not.toContain(TEAM_ID);
    });

    it('stays quiet for any other error', () => {
      normalizeApiError(axiosError(403, { error: 'Forbidden' }));
      normalizeApiError(axiosError(500, { error: 'boom' }));
      normalizeApiError(new Error('plain'));
      expect(mockedTrack).not.toHaveBeenCalled();
    });
  });

  describe('error_shown', () => {
    it('reports the server code, status and route pattern, and never the message', () => {
      const error = normalizeApiError(
        axiosError(400, { error: 'Jersey 23 is taken by Jordan', code: 'jersey_taken' })
      );
      const message = getApiErrorMessage(error, 'fallback');
      expect(message).toBe('Jersey 23 is taken by Jordan');
      expect(mockedTrack).toHaveBeenCalledWith('error_shown', {
        code: 'jersey_taken',
        status: 400,
        endpoint_pattern: '/api/v1/teams/:id/players',
      });
      expect(JSON.stringify(mockedTrack.mock.calls)).not.toContain('Jordan');
      expect(JSON.stringify(mockedTrack.mock.calls)).not.toContain(TEAM_ID);
    });

    it('uses http_error when the body has no code and axios has none', () => {
      getApiErrorMessage(axiosError(404, { error: 'Not found' }), 'fallback');
      expect(mockedTrack).toHaveBeenCalledWith('error_shown', {
        code: 'http_error',
        status: 404,
        endpoint_pattern: '/api/v1/teams/:id/players',
      });
    });

    it('reports a network failure with a null status and the axios code', () => {
      getApiErrorMessage(axiosError(undefined), 'fallback');
      expect(mockedTrack).toHaveBeenCalledWith('error_shown', {
        code: 'ECONNABORTED',
        status: null,
        endpoint_pattern: '/api/v1/teams/:id/players',
      });
    });

    it('reports a plain Error by its name only', () => {
      expect(getApiErrorMessage(new TypeError('bad'), 'fallback')).toBe('bad');
      expect(mockedTrack).toHaveBeenCalledWith('error_shown', { code: 'TypeError', status: null, endpoint_pattern: '' });
      expect(getApiErrorMessage('oops', 'fallback')).toBe('fallback');
      expect(mockedTrack).toHaveBeenLastCalledWith('error_shown', { code: 'unknown', status: null, endpoint_pattern: '' });
    });
  });
});
