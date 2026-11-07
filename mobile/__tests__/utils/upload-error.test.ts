/**
 * What a photo-saving screen shows when the server refuses an expired upload
 * (400 `upload_expired`, backend #1005), through the real `normalizeApiError`
 * and the real i18n instance in every locale.
 */
import { AxiosError, AxiosHeaders } from 'axios';
import { i18n } from '../../i18n';
import { apiErrorCode, isUpgradeRequiredError, normalizeApiError } from '../../services/api-client';
import {
  AvatarUploadError,
  UPLOAD_EXPIRED_CODE,
  uploadAwareErrorMessage,
  uploadErrorMessageKey,
} from '../../utils/upload-error';

jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
// jest.setup.js stubs the api-client; this suite needs the real normalizeApiError.
jest.mock('../../services/api-client', () => ({
  ...jest.requireActual('../../services/api-client'),
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

function apiError(status: number, body: Record<string, unknown>): unknown {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: 'x',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: body,
  });
  return normalizeApiError(error);
}

const EXPIRED = (): unknown =>
  apiError(400, { error: 'That photo upload expired. Please choose it again.', code: UPLOAD_EXPIRED_CODE });

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('upload_expired (#1005)', () => {
  it('maps the server code to the avatar.uploadExpired key', () => {
    expect(UPLOAD_EXPIRED_CODE).toBe('upload_expired');
    expect(uploadErrorMessageKey(EXPIRED())).toBe('avatar.uploadExpired');
  });

  it('shows the localized message, not the server text, in every locale', async () => {
    const t = i18n.t.bind(i18n);
    expect(uploadAwareErrorMessage(EXPIRED(), t, 'roster.addFailed')).toBe(
      'That photo upload expired. Please choose it again.'
    );

    await i18n.changeLanguage('es');
    const es = uploadAwareErrorMessage(EXPIRED(), i18n.t.bind(i18n), 'roster.addFailed');
    expect(es).toBe('La subida de esa foto caducó. Vuelve a elegirla.');
  });

  it('reads apiError.code first, then the lifted code (both shapes)', () => {
    // Only the body, as on an error that was never lifted
    expect(uploadErrorMessageKey({ apiError: { code: UPLOAD_EXPIRED_CODE, status: 400 } })).toBe('avatar.uploadExpired');
    // Only the lifted code
    expect(uploadErrorMessageKey({ code: UPLOAD_EXPIRED_CODE })).toBe('avatar.uploadExpired');
    // The body wins over axios' own code
    expect(uploadErrorMessageKey({ apiError: { code: UPLOAD_EXPIRED_CODE }, code: 'ERR_BAD_REQUEST' })).toBe(
      'avatar.uploadExpired'
    );
    expect(uploadErrorMessageKey({ apiError: { code: 'forbidden' }, code: UPLOAD_EXPIRED_CODE })).toBeUndefined();
  });

  it('leaves other server refusals to their own message', () => {
    const forbidden = apiError(403, { error: 'You do not have permission', code: 'forbidden' });
    expect(uploadErrorMessageKey(forbidden)).toBeUndefined();
    expect(uploadAwareErrorMessage(forbidden, i18n.t.bind(i18n), 'roster.addFailed')).toBe(
      'You do not have permission'
    );
  });

  it('still maps client-side upload failures and ignores non-objects', () => {
    expect(uploadErrorMessageKey(new AvatarUploadError('too big', 'avatar.tooLarge'))).toBe('avatar.tooLarge');
    expect(uploadErrorMessageKey(null)).toBeUndefined();
    expect(uploadErrorMessageKey('upload_expired')).toBeUndefined();
  });
});

describe('apiErrorCode (shared with isUpgradeRequiredError)', () => {
  it('reads the body code first, then the lifted code, and ignores non-strings', () => {
    expect(apiErrorCode({ apiError: { code: 'a' }, code: 'b' })).toBe('a');
    expect(apiErrorCode({ code: 'b' })).toBe('b');
    expect(apiErrorCode({ apiError: { code: 7 } })).toBeUndefined();
    expect(apiErrorCode(null)).toBeUndefined();
    expect(apiErrorCode('upload_expired')).toBeUndefined();
  });

  it('isUpgradeRequiredError reads the code through it', () => {
    expect(isUpgradeRequiredError(apiError(403, { error: 'x', code: 'upgrade_required' }))).toBe(true);
    expect(isUpgradeRequiredError(apiError(403, { error: 'x', code: 'forbidden' }))).toBe(false);
  });
});
