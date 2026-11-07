/**
 * The server's machine-readable `code` on a failed request: the body's
 * `apiError.code` first, then the `code` that `normalizeApiError`
 * (`services/api-client.ts`) lifts onto the error. Axios' own codes (such as
 * `ERR_BAD_REQUEST`) only ever reach the second slot, so a body code wins.
 *
 * Kept free of imports so modules that read a code (`utils/upload-error.ts`)
 * keep working in tests that mock the api-client; `services/api-client.ts`
 * re-exports it as the one helper for this.
 */
export function apiErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { apiError, code } = error as { apiError?: { code?: unknown }; code?: unknown };
  const value = apiError?.code ?? code;
  return typeof value === 'string' ? value : undefined;
}
