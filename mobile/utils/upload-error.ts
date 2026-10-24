/**
 * A failed avatar upload (#671). `message` stays English: it goes to Sentry as is,
 * so one failure groups as one issue whatever the device language. Screens show
 * `userMessageKey`, an i18n key, instead. Lives outside `services/upload-service`
 * so screen tests that mock the service still get a working check.
 */
/** The i18n keys an upload failure can show. */
export type AvatarUploadMessageKey = 'avatar.unreadable' | 'avatar.tooLarge' | 'avatar.uploadFailed';

type Translate = (key: string) => string;

export class AvatarUploadError extends Error {
  readonly userMessageKey: AvatarUploadMessageKey;

  constructor(message: string, userMessageKey: AvatarUploadMessageKey) {
    super(message);
    this.name = 'AvatarUploadError';
    this.userMessageKey = userMessageKey;
  }
}

/** The i18n key to show for an upload failure, or `undefined` for any other error. */
export function uploadErrorMessageKey(error: unknown): AvatarUploadMessageKey | undefined {
  return error instanceof AvatarUploadError ? error.userMessageKey : undefined;
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
