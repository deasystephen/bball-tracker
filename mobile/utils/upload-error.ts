import { apiErrorCode } from './api-error-code';

/**
 * A failed avatar upload (#671). `message` stays English: it goes to Sentry as is,
 * so one failure groups as one issue whatever the device language. Screens show
 * `userMessageKey`, an i18n key, instead. Lives outside `services/upload-service`
 * so screen tests that mock the service still get a working check.
 */
/** The i18n keys an upload failure can show. */
export type AvatarUploadMessageKey =
  | 'avatar.unreadable'
  | 'avatar.tooLarge'
  | 'avatar.uploadFailed'
  | 'avatar.uploadExpired';

/**
 * The server's 400 `code` when a profile write names an upload that no longer
 * exists: it was never saved within the pending window and S3 expired it
 * (backend #1005). The user has to choose the photo again.
 */
export const UPLOAD_EXPIRED_CODE = 'upload_expired';

type Translate = (key: string) => string;

export class AvatarUploadError extends Error {
  readonly userMessageKey: AvatarUploadMessageKey;

  constructor(message: string, userMessageKey: AvatarUploadMessageKey) {
    super(message);
    this.name = 'AvatarUploadError';
    this.userMessageKey = userMessageKey;
  }
}

/**
 * The i18n key to show for an upload failure, or `undefined` for any other error:
 * a client-side `AvatarUploadError`, or the server's `upload_expired` refusal. The
 * server code is read with `apiErrorCode`, the same helper `isUpgradeRequiredError`
 * uses.
 */
export function uploadErrorMessageKey(error: unknown): AvatarUploadMessageKey | undefined {
  if (error instanceof AvatarUploadError) return error.userMessageKey;
  return apiErrorCode(error) === UPLOAD_EXPIRED_CODE ? 'avatar.uploadExpired' : undefined;
}

/**
 * What a screen shows for an error from a flow that may upload a photo: the localized
 * upload message, else the error's own message (server text), else `fallbackKey`.
 */
export function uploadAwareErrorMessage(error: unknown, t: Translate, fallbackKey: string): string {
  const key = uploadErrorMessageKey(error);
  if (key) return t(key);
  return error instanceof Error && error.message ? error.message : t(fallbackKey);
}
