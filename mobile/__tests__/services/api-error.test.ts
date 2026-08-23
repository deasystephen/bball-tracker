/**
 * Tests for the API error normalization added for audit #40.
 *
 * The backend answers errors with `{ error, code?, ... }`; axios' own message
 * is the useless "Request failed with status code N". The interceptor lifts
 * the server text onto `error.message` / `error.code` / `error.apiError` so
 * the ~36 `error instanceof Error ? error.message : fallback` call sites and
 * the 402 `upgrade_required` CTA get the real reason.
 */

import {
  normalizeApiError,
  isUpgradeRequiredError,
  getApiErrorMessage,
  UPGRADE_REQUIRED_CODE,
  type NormalizedApiError,
} from '../../services/api-client';

// jest hoists unmock/mock calls above the imports.
jest.unmock('../../services/api-client');

type Handler = (input: unknown) => unknown;
const responseErrorHandlers: Handler[] = [];

jest.mock('axios', () => {
  const create = jest.fn(() => ({
    interceptors: {
      request: { use: jest.fn() },
      response: {
        use: (_onOk: Handler, onErr: Handler) => {
          responseErrorHandlers.push(onErr);
        },
      },
    },
  }));
  return { __esModule: true, default: { create }, create };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'https://example.test' } } },
}));

jest.mock('../../store/auth-store', () => ({
  __esModule: true,
  useAuthStore: { getState: () => ({ accessToken: null, refreshToken: null, logout: jest.fn() }) },
}));

const axiosError = (status: number, data: unknown, message = `Request failed with status code ${status}`) =>
  Object.assign(new Error(message), {
    isAxiosError: true,
    response: { status, data },
  });

describe('normalizeApiError', () => {
  it('lifts the server error text and code onto the error', () => {
    const err = axiosError(402, {
      error: 'Free tier is limited to 3 teams',
      code: UPGRADE_REQUIRED_CODE,
      feature: 'TEAMS',
      currentTier: 'FREE',
      requiredTier: 'PREMIUM',
    });

    const out = normalizeApiError(err) as NormalizedApiError;

    expect(out).toBe(err); // same object: instanceof / response still work
    expect(out.message).toBe('Free tier is limited to 3 teams');
    expect(out.code).toBe(UPGRADE_REQUIRED_CODE);
    expect(out.apiError).toEqual({
      status: 402,
      error: 'Free tier is limited to 3 teams',
      code: UPGRADE_REQUIRED_CODE,
      feature: 'TEAMS',
      currentTier: 'FREE',
      requiredTier: 'PREMIUM',
    });
  });

  it('falls back to `message` when the body has no `error`', () => {
    const out = normalizeApiError(axiosError(400, { message: 'Validation failed' })) as NormalizedApiError;
    expect(out.message).toBe('Validation failed');
    expect(out.code).toBeUndefined();
  });

  it('keeps the axios message when the body is empty, blank, or not JSON', () => {
    expect((normalizeApiError(axiosError(500, {})) as Error).message).toBe('Request failed with status code 500');
    expect((normalizeApiError(axiosError(500, { error: '   ' })) as Error).message).toBe(
      'Request failed with status code 500'
    );
    expect((normalizeApiError(axiosError(502, '<html>Bad Gateway</html>')) as Error).message).toBe(
      'Request failed with status code 502'
    );
    expect((normalizeApiError(axiosError(404, null)) as Error).message).toBe('Request failed with status code 404');
  });

  it('passes through network errors and non-axios values untouched', () => {
    const network = Object.assign(new Error('timeout of 10000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
    expect(normalizeApiError(network)).toBe(network);
    expect(network.message).toBe('timeout of 10000ms exceeded');
    expect(network.code).toBe('ECONNABORTED');

    const plain = new Error('boom');
    expect(normalizeApiError(plain)).toBe(plain);
    expect(normalizeApiError('string')).toBe('string');
    expect(normalizeApiError(undefined)).toBeUndefined();
  });
});

describe('isUpgradeRequiredError', () => {
  it('is true for a 402 or an upgrade_required code', () => {
    expect(isUpgradeRequiredError(normalizeApiError(axiosError(402, { error: 'x' })))).toBe(true);
    expect(
      isUpgradeRequiredError(normalizeApiError(axiosError(403, { error: 'x', code: UPGRADE_REQUIRED_CODE })))
    ).toBe(true);
  });
  it('is false for other errors', () => {
    expect(isUpgradeRequiredError(normalizeApiError(axiosError(403, { error: 'Forbidden' })))).toBe(false);
    expect(isUpgradeRequiredError(new Error('x'))).toBe(false);
    expect(isUpgradeRequiredError(null)).toBe(false);
  });
});

describe('getApiErrorMessage', () => {
  it('prefers the server text, then Error.message, then the fallback', () => {
    expect(getApiErrorMessage(normalizeApiError(axiosError(409, { error: 'Name taken' })), 'fb')).toBe('Name taken');
    expect(getApiErrorMessage(new Error('boom'), 'fb')).toBe('boom');
    expect(getApiErrorMessage('nope', 'fb')).toBe('fb');
    expect(getApiErrorMessage(new Error(''), 'fb')).toBe('fb');
  });
});

describe('interceptor registration', () => {
  it('registers the normalizer before the auth (401) interceptor so both run', async () => {
    expect(responseErrorHandlers.length).toBeGreaterThanOrEqual(2);
    const [normalizer] = responseErrorHandlers;
    const err = axiosError(402, { error: 'Upgrade', code: UPGRADE_REQUIRED_CODE });
    await expect(normalizer(err)).rejects.toBe(err);
    expect((err as NormalizedApiError).code).toBe(UPGRADE_REQUIRED_CODE);
    expect(err.message).toBe('Upgrade');
  });
});
